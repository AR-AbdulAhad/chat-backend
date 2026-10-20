import { createHmac } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { emitToUsers } from "../../lib/realtime.js";
import { storage } from "../../lib/storage.js";
import { audit } from "../../lib/audit.js";
import { partnerIdOf } from "../users/service.js";
import { pushToUser } from "../notifications/service.js";
import { scheduleCallTimeout } from "../../jobs/queue.js";
import type { CallRecord, CallType } from "../../generated/prisma/client.js";

/** STUN + time-limited TURN credentials (coturn `use-auth-secret` / TURN REST API). */
export function iceServers(userId: string) {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [];
  const stun = env.STUN_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (stun.length) servers.push({ urls: stun });
  const turn = env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (turn.length && env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + env.TURN_TTL_SEC}:${userId}`;
    const credential = createHmac("sha1", env.TURN_SECRET).update(username).digest("base64");
    servers.push({ urls: turn, username, credential });
  }
  return { iceServers: servers, ttlSeconds: env.TURN_TTL_SEC };
}

export function shapeCall(c: CallRecord) {
  return {
    id: c.id,
    callerId: c.callerId,
    calleeId: c.calleeId,
    type: c.type,
    state: c.state,
    startedAt: c.startedAt,
    answeredAt: c.answeredAt,
    endedAt: c.endedAt,
    endReason: c.endReason,
    durationSec: c.answeredAt && c.endedAt ? Math.round((c.endedAt.getTime() - c.answeredAt.getTime()) / 1000) : 0,
  };
}

async function loadCallFor(userId: string, callId: string) {
  const call = await prisma.callRecord.findUnique({ where: { id: callId } });
  if (!call) throw notFound("call_not_found");
  if (call.callerId !== userId && call.calleeId !== userId) throw forbidden("not_participant");
  return call;
}

const ACTIVE = ["ringing", "accepted"] as const;

export async function startCall(userId: string, type: CallType) {
  const partnerId = await partnerIdOf(userId);
  if (!partnerId) throw notFound("no_partner");
  // Stale calls (crash, lost network) older than 4h are closed first.
  await prisma.callRecord.updateMany({
    where: { state: { in: [...ACTIVE] }, startedAt: { lt: new Date(Date.now() - 4 * 3600_000) } },
    data: { state: "failed", endedAt: new Date(), endReason: "stale" },
  });
  const busy = await prisma.callRecord.findFirst({ where: { state: { in: [...ACTIVE] } } });
  if (busy) throw conflict("busy", "A call is already in progress");

  const call = await prisma.callRecord.create({ data: { callerId: userId, calleeId: partnerId, type } });
  const caller = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
  const payload = { ...shapeCall(call), callerName: caller.displayName };
  emitToUsers([partnerId], "call:incoming", payload);
  emitToUsers([userId], "call:outgoing", payload);
  // High-priority push wakes a backgrounded / terminated app to show the call UI.
  void pushToUser(partnerId, {
    priority: "high",
    ttlSeconds: env.CALL_RING_TIMEOUT_SEC,
    collapseKey: `call_${call.id}`,
    data: { type: "call_incoming", callId: call.id, callType: type, callerId: userId, callerName: caller.displayName, startedAt: call.startedAt.toISOString() },
  });
  await scheduleCallTimeout(call.id, env.CALL_RING_TIMEOUT_SEC * 1000);
  return { call: payload, ...iceServers(userId) };
}

export async function acceptCall(userId: string, callId: string) {
  const call = await loadCallFor(userId, callId);
  if (call.calleeId !== userId) throw forbidden("only_callee_can_accept");
  const updated = await prisma.callRecord.updateMany({ where: { id: callId, state: "ringing" }, data: { state: "accepted", answeredAt: new Date() } });
  if (updated.count !== 1) throw conflict("call_not_ringing");
  const fresh = await prisma.callRecord.findUniqueOrThrow({ where: { id: callId } });
  emitToUsers([call.callerId, call.calleeId], "call:accepted", shapeCall(fresh));
  return { call: shapeCall(fresh), ...iceServers(userId) };
}

export async function finishCall(userId: string | null, callId: string, reason: string) {
  const call = userId ? await loadCallFor(userId, callId) : await prisma.callRecord.findUnique({ where: { id: callId } });
  if (!call) throw notFound("call_not_found");
  if (!ACTIVE.includes(call.state as (typeof ACTIVE)[number])) return shapeCall(call);

  let state: CallRecord["state"];
  if (call.state === "accepted") state = reason === "failed" ? "failed" : "ended";
  else if (reason === "timeout") state = "missed";
  else if (userId === call.calleeId) state = "rejected";
  else state = "cancelled";

  const updated = await prisma.callRecord.updateMany({
    where: { id: callId, state: call.state },
    data: { state, endedAt: new Date(), endReason: reason.slice(0, 40) },
  });
  const fresh = await prisma.callRecord.findUniqueOrThrow({ where: { id: callId } });
  if (updated.count === 1) {
    emitToUsers([call.callerId, call.calleeId], "call:ended", shapeCall(fresh));
    if (state === "missed" || state === "cancelled") {
      const caller = await prisma.user.findUniqueOrThrow({ where: { id: call.callerId }, select: { displayName: true } });
      void pushToUser(call.calleeId, {
        priority: "high",
        collapseKey: `call_${call.id}`,
        data: { type: "call_missed", callId: call.id, callType: call.type, callerName: caller.displayName, startedAt: call.startedAt.toISOString() },
      });
    }
  }
  return shapeCall(fresh);
}

/** Relays SDP / ICE between the two participants of an active call. */
export async function relaySignal(userId: string, callId: string, data: unknown) {
  const call = await loadCallFor(userId, callId);
  if (!ACTIVE.includes(call.state as (typeof ACTIVE)[number])) throw badRequest("call_not_active");
  const to = call.callerId === userId ? call.calleeId : call.callerId;
  emitToUsers([to], "call:signal", { callId, from: userId, data });
}

export async function callHistory(userId: string, before: Date | undefined, limit: number) {
  const rows = await prisma.callRecord.findMany({
    where: { OR: [{ callerId: userId }, { calleeId: userId }], ...(before ? { startedAt: { lt: before } } : {}) },
    orderBy: { startedAt: "desc" },
    take: limit,
    include: { recordings: { where: { deletedAt: null, attachmentId: { not: null } }, select: { id: true } } },
  });
  return rows.map((r) => ({ ...shapeCall(r), recordingIds: r.recordings.map((x) => x.id) }));
}

// ----- Recording (explicit consent from the other participant is mandatory) -----

export async function requestRecording(userId: string, callId: string) {
  const call = await loadCallFor(userId, callId);
  if (call.state !== "accepted") throw badRequest("call_not_active");
  const other = call.callerId === userId ? call.calleeId : call.callerId;
  emitToUsers([other], "call:recording-request", { callId, requestedBy: userId });
}

export async function answerRecordingRequest(userId: string, callId: string, accepted: boolean) {
  const call = await loadCallFor(userId, callId);
  if (call.state !== "accepted") throw badRequest("call_not_active");
  const requester = call.callerId === userId ? call.calleeId : call.callerId;
  if (!accepted) {
    emitToUsers([requester], "call:recording-declined", { callId });
    return null;
  }
  const rec = await prisma.callRecording.create({
    data: { callId, ownerId: requester, consentedById: userId, consentedAt: new Date() },
  });
  await audit("recording_consented", { userId, meta: { callId, recordingId: rec.id } });
  // Both screens show a persistent recording indicator.
  emitToUsers([call.callerId, call.calleeId], "call:recording-started", { callId, recordingId: rec.id, ownerId: requester });
  return rec.id;
}

export async function stopRecording(userId: string, callId: string) {
  const call = await loadCallFor(userId, callId);
  emitToUsers([call.callerId, call.calleeId], "call:recording-stopped", { callId, stoppedBy: userId });
}

export async function attachRecording(userId: string, recordingId: string, input: { attachmentId: string; ciphertext: string; nonce: string }) {
  const rec = await prisma.callRecording.findUnique({ where: { id: recordingId } });
  if (!rec || rec.deletedAt) throw notFound("recording_not_found");
  if (rec.ownerId !== userId) throw forbidden("not_recording_owner");
  if (rec.attachmentId) throw conflict("already_attached");
  const att = await prisma.messageAttachment.findUnique({ where: { id: input.attachmentId } });
  if (!att || att.uploaderId !== userId || !att.uploadedAt || att.kind !== "call_recording" || att.messageId) {
    throw badRequest("invalid_attachment");
  }
  const updated = await prisma.callRecording.update({
    where: { id: recordingId },
    data: { attachmentId: att.id, ciphertext: input.ciphertext, nonce: input.nonce },
  });
  const call = await prisma.callRecord.findUniqueOrThrow({ where: { id: rec.callId } });
  emitToUsers([call.callerId, call.calleeId], "call:recording-saved", { callId: call.id, recordingId });
  return updated;
}

export async function listRecordings(userId: string) {
  const rows = await prisma.callRecording.findMany({
    where: { deletedAt: null, attachmentId: { not: null }, call: { OR: [{ callerId: userId }, { calleeId: userId }] } },
    orderBy: { createdAt: "desc" },
    include: { call: true },
  });
  return rows.map((r) => ({
    id: r.id,
    callId: r.callId,
    ownerId: r.ownerId,
    consentedById: r.consentedById,
    consentedAt: r.consentedAt,
    attachmentId: r.attachmentId,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
    createdAt: r.createdAt,
    call: shapeCall(r.call),
  }));
}

/** Either participant may delete a recording of a call they were part of. */
export async function deleteRecording(userId: string, recordingId: string) {
  const rec = await prisma.callRecording.findUnique({ where: { id: recordingId }, include: { call: true } });
  if (!rec || rec.deletedAt) throw notFound("recording_not_found");
  if (rec.call.callerId !== userId && rec.call.calleeId !== userId) throw forbidden("not_participant");
  await removeRecording(rec.id, rec.attachmentId);
  await audit("recording_deleted", { userId, meta: { recordingId } });
  emitToUsers([rec.call.callerId, rec.call.calleeId], "call:recording-deleted", { recordingId });
}

export async function removeRecording(recordingId: string, attachmentId: string | null) {
  await prisma.callRecording.update({ where: { id: recordingId }, data: { deletedAt: new Date() } });
  if (attachmentId) {
    const att = await prisma.messageAttachment.update({ where: { id: attachmentId }, data: { deletedAt: new Date() } });
    await storage.remove(att.objectKey).catch(() => undefined);
  }
}
