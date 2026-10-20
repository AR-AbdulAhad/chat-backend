import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, clientId, connect, createPair, emitAck, envelope, objects, pushes, resetDb, startTestServer, stopTestServer, uploadFake, waitFor } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { expireStatuses } from "../src/modules/statuses/service.js";
import { cleanupRecordings, cleanupUploads } from "../src/jobs/processors.js";

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDb);

describe("media uploads", () => {
  it("enforces per-kind size limits", async () => {
    const { a } = await createPair();
    const res = await api().post("/api/v1/media/uploads").set(auth(a)).send({ kind: "image", sizeBytes: 500 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("file_too_large");
  });

  it("does not complete an upload whose object is missing or the wrong size", async () => {
    const { a } = await createPair();
    const res = await api().post("/api/v1/media/uploads").set(auth(a)).send({ kind: "image", sizeBytes: 1234 });
    const missing = await api().post(`/api/v1/media/uploads/${res.body.attachmentId}/complete`).set(auth(a));
    expect(missing.status).toBe(400);
    objects.set(new URL(res.body.uploadUrl).pathname.slice(1), 999);
    const wrong = await api().post(`/api/v1/media/uploads/${res.body.attachmentId}/complete`).set(auth(a));
    expect(wrong.body.error.code).toBe("size_mismatch");
  });

  it("only exposes media through short-lived URLs to authorized users", async () => {
    const { a, b } = await createPair();
    const attId = await uploadFake(a, "image");
    // Not yet attached to a message: the partner cannot fetch it.
    expect((await api().get(`/api/v1/media/${attId}/url`).set(auth(b))).status).toBe(403);
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "image", attachmentIds: [attId], ...envelope() });
    const url = await api().get(`/api/v1/media/${attId}/url`).set(auth(b));
    expect(url.status).toBe(200);
    expect(url.body.url).toContain("sig=get");
    expect((await api().get(`/api/v1/media/${attId}/url`)).status).toBe(401);
  });

  it("refuses to attach someone else's upload or reuse an attachment", async () => {
    const { a, b } = await createPair();
    const attId = await uploadFake(a, "image");
    const steal = await api().post("/api/v1/messages").set(auth(b)).send({ clientId: clientId(), type: "image", attachmentIds: [attId], ...envelope() });
    expect(steal.status).toBe(400);
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "image", attachmentIds: [attId], ...envelope() });
    const reuse = await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "image", attachmentIds: [attId], ...envelope() });
    expect(reuse.status).toBe(400);
  });

  it("removes the object when a message is deleted for everyone", async () => {
    const { a } = await createPair();
    const attId = await uploadFake(a, "voice");
    const msg = (await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "voice", attachmentIds: [attId], ...envelope() })).body;
    expect(objects.size).toBe(1);
    await api().delete(`/api/v1/messages/${msg.id}`).set(auth(a));
    expect(objects.size).toBe(0);
  });

  it("cleans up abandoned uploads", async () => {
    const { a } = await createPair();
    const attId = await uploadFake(a, "image");
    await prisma.messageAttachment.update({ where: { id: attId }, data: { uploadedAt: new Date(Date.now() - 8 * 24 * 3600_000) } });
    expect(await cleanupUploads()).toBe(1);
    expect(objects.size).toBe(0);
  });
});

describe("statuses", () => {
  it("creates statuses with 24/48/72 hour expiry only", async () => {
    const { a } = await createPair();
    for (const h of [24, 48, 72]) {
      const r = await api().post("/api/v1/statuses").set(auth(a)).send({ kind: "text", expiresInHours: h, ...envelope() });
      expect(r.status).toBe(201);
      const hours = (new Date(r.body.expiresAt).getTime() - new Date(r.body.createdAt).getTime()) / 3600_000;
      expect(Math.round(hours)).toBe(h);
    }
    const bad = await api().post("/api/v1/statuses").set(auth(a)).send({ kind: "text", expiresInHours: 96, ...envelope() });
    expect(bad.status).toBe(400);
  });

  it("notifies the partner, records views, and shows viewers to the owner", async () => {
    const { a, b } = await createPair();
    const sb = await connect(b);
    const sa = await connect(a);
    const incoming = waitFor(sb, "status:new");
    const attId = await uploadFake(a, "status_media");
    const created = (await api().post("/api/v1/statuses").set(auth(a)).send({ kind: "photo", attachmentId: attId, expiresInHours: 24, ...envelope() })).body;
    expect((await incoming).id).toBe(created.id);

    // Partner can download the status media while it is active.
    expect((await api().get(`/api/v1/media/${attId}/url`).set(auth(b))).status).toBe(200);

    const viewed = waitFor(sa, "status:viewed");
    await api().post(`/api/v1/statuses/${created.id}/view`).set(auth(b));
    expect((await viewed).viewerId).toBe(b.id);
    const own = await api().get("/api/v1/statuses").set(auth(a));
    expect(own.body.statuses[0].views).toHaveLength(1);
    sa.close();
    sb.close();
  });

  it("lets only the owner delete a status", async () => {
    const { a, b } = await createPair();
    const s = (await api().post("/api/v1/statuses").set(auth(a)).send({ kind: "text", expiresInHours: 24, ...envelope() })).body;
    expect((await api().delete(`/api/v1/statuses/${s.id}`).set(auth(b))).status).toBe(403);
    expect((await api().delete(`/api/v1/statuses/${s.id}`).set(auth(a))).status).toBe(204);
    expect((await api().get("/api/v1/statuses").set(auth(b))).body.statuses).toHaveLength(0);
  });

  it("server-side expiry removes the status and its media", async () => {
    const { a, b } = await createPair();
    const attId = await uploadFake(a, "status_media");
    const s = (await api().post("/api/v1/statuses").set(auth(a)).send({ kind: "photo", attachmentId: attId, expiresInHours: 24, ...envelope() })).body;
    expect(objects.size).toBe(1);
    expect(await expireStatuses(new Date(Date.now() + 25 * 3600_000))).toBe(1);
    expect(objects.size).toBe(0);
    expect((await api().get("/api/v1/statuses").set(auth(b))).body.statuses).toHaveLength(0);
    expect((await api().get(`/api/v1/media/${attId}/url`).set(auth(b))).status).toBe(404);
    expect((await prisma.status.findUniqueOrThrow({ where: { id: s.id } })).deletedAt).not.toBeNull();
  });

  it("supports replying to a status through the conversation", async () => {
    const { a, b } = await createPair();
    const s = (await api().post("/api/v1/statuses").set(auth(a)).send({ kind: "text", expiresInHours: 24, ...envelope() })).body;
    const reply = await api().post("/api/v1/messages").set(auth(b)).send({ clientId: clientId(), type: "status_reply", statusId: s.id, ...envelope() });
    expect(reply.status).toBe(201);
    expect(reply.body.statusId).toBe(s.id);
    // You cannot "reply" to your own status.
    const self = await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "status_reply", statusId: s.id, ...envelope() });
    expect(self.status).toBe(400);
  });
});

describe("calls", () => {
  it("rings the partner (socket + high-priority push), connects, relays signaling and records history", async () => {
    const { a, b } = await createPair();
    await api().put("/api/v1/devices/push-token").set(auth(b)).send({ token: "zara-fcm-token-000000000000" });
    const sa = await connect(a);
    const sb = await connect(b);

    const incoming = waitFor(sb, "call:incoming");
    const start = await emitAck(sa, "call:start", { type: "video" });
    expect(start.ok).toBe(true);
    const callId = start.data.call.id;
    expect(start.data.iceServers.some((s: any) => s.username && s.credential)).toBe(true);
    expect((await incoming).id).toBe(callId);
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.find((p) => p.payload.data.type === "call_incoming")?.payload.priority).toBe("high");

    const accepted = waitFor(sa, "call:accepted");
    expect((await emitAck(sb, "call:accept", { callId })).ok).toBe(true);
    expect((await accepted).state).toBe("accepted");

    const signal = waitFor(sb, "call:signal");
    await emitAck(sa, "call:signal", { callId, data: { type: "offer", sdp: "v=0\r\n" } });
    const s = await signal;
    expect(s.from).toBe(a.id);
    expect(s.data.type).toBe("offer");

    const ended = waitFor(sb, "call:ended");
    await emitAck(sa, "call:end", { callId, reason: "hangup" });
    expect((await ended).state).toBe("ended");

    const history = await api().get("/api/v1/calls").set(auth(b));
    expect(history.body.calls[0].id).toBe(callId);
    expect(history.body.calls[0].type).toBe("video");
    sa.close();
    sb.close();
  });

  it("marks unanswered calls as missed after the ring timeout and pushes a missed-call notice", async () => {
    const { a, b } = await createPair();
    await api().put("/api/v1/devices/push-token").set(auth(b)).send({ token: "zara-fcm-token-000000000000" });
    const sa = await connect(a);
    const ended = waitFor(sa, "call:ended", 8000);
    const start = await emitAck(sa, "call:start", { type: "voice" });
    expect((await ended).state).toBe("missed");
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes.some((p) => p.payload.data.type === "call_missed" && p.payload.data.callId === start.data.call.id)).toBe(true);
    sa.close();
  });

  it("rejects, reports busy, and blocks outsiders from signaling", async () => {
    const { a, b } = await createPair();
    const sa = await connect(a);
    const sb = await connect(b);
    const start = await emitAck(sa, "call:start", { type: "voice" });
    const callId = start.data.call.id;
    const busy = await emitAck(sb, "call:start", { type: "voice" });
    expect(busy.ok).toBe(false);
    expect(busy.error.code).toBe("busy");
    // Caller cannot accept their own call.
    expect((await emitAck(sa, "call:accept", { callId })).error.code).toBe("only_callee_can_accept");
    const ended = waitFor(sa, "call:ended");
    await emitAck(sb, "call:end", { callId, reason: "rejected" });
    expect((await ended).state).toBe("rejected");
    // Signaling on a finished call is refused.
    const late = await emitAck(sa, "call:signal", { callId, data: { type: "offer", sdp: "v=0" } });
    expect(late.ok).toBe(false);
    sa.close();
    sb.close();
  });

  it("requires the other participant's consent before a recording exists", async () => {
    const { a, b } = await createPair();
    const sa = await connect(a);
    const sb = await connect(b);
    const callId = (await emitAck(sa, "call:start", { type: "voice" })).data.call.id;
    await emitAck(sb, "call:accept", { callId });

    const request = waitFor(sb, "call:recording-request");
    await emitAck(sa, "call:recording-request", { callId });
    expect((await request).requestedBy).toBe(a.id);

    const declined = waitFor(sa, "call:recording-declined");
    await emitAck(sb, "call:recording-consent", { callId, accepted: false });
    await declined;
    expect(await prisma.callRecording.count()).toBe(0);

    await emitAck(sa, "call:recording-request", { callId });
    const started = waitFor(sa, "call:recording-started");
    const startedB = waitFor(sb, "call:recording-started");
    await emitAck(sb, "call:recording-consent", { callId, accepted: true });
    const { recordingId } = await started;
    await startedB; // both sides show the indicator

    const attId = await uploadFake(a, "call_recording", 5000);
    expect((await api().put(`/api/v1/calls/recordings/${recordingId}`).set(auth(b)).send({ attachmentId: attId, ...envelope() })).status).toBe(403);
    expect((await api().put(`/api/v1/calls/recordings/${recordingId}`).set(auth(a)).send({ attachmentId: attId, ...envelope() })).status).toBe(204);
    const list = await api().get("/api/v1/calls/recordings").set(auth(b));
    expect(list.body.recordings).toHaveLength(1);
    expect((await api().get(`/api/v1/media/${attId}/url`).set(auth(b))).status).toBe(200);

    // Either participant may delete it.
    expect((await api().delete(`/api/v1/calls/recordings/${recordingId}`).set(auth(b))).status).toBe(204);
    expect(objects.size).toBe(0);
    sa.close();
    sb.close();
  });

  it("applies recording retention", async () => {
    const { a, b } = await createPair();
    const call = await prisma.callRecord.create({ data: { callerId: a.id, calleeId: b.id, type: "voice", state: "ended" } });
    await prisma.callRecording.create({ data: { callId: call.id, ownerId: a.id, consentedById: b.id, consentedAt: new Date(), createdAt: new Date(Date.now() - 100 * 24 * 3600_000) } });
    expect(await cleanupRecordings()).toBe(1);
  });

  it("issues time-limited TURN credentials", async () => {
    const { a } = await createPair();
    const res = await api().get("/api/v1/calls/ice-servers").set(auth(a));
    const turn = res.body.iceServers.find((s: any) => s.username);
    const [expiry, user] = turn.username.split(":");
    expect(user).toBe(a.id);
    expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000);
  });
});
