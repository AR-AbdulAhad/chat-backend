import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { emitToUsers } from "../../lib/realtime.js";
import { partnerIdOf } from "../users/service.js";
import { pushToUser } from "../notifications/service.js";
import type { StatusKind } from "../../generated/prisma/client.js";

export interface CreateStatus {
  kind: StatusKind;
  ciphertext: string;
  nonce: string;
  attachmentId?: string | null;
  expiresInHours: 24 | 48 | 72;
}

const statusInclude = { views: { select: { viewerId: true, viewedAt: true } } } as const;

function shape(s: { id: string; userId: string; kind: StatusKind; ciphertext: string; nonce: string; attachmentId: string | null; expiresAt: Date; createdAt: Date; views: { viewerId: string; viewedAt: Date }[] }, viewerId: string) {
  return {
    id: s.id,
    userId: s.userId,
    kind: s.kind,
    ciphertext: s.ciphertext,
    nonce: s.nonce,
    attachmentId: s.attachmentId,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    // Owner sees the full viewer list; the viewer sees whether they've viewed.
    views: s.userId === viewerId ? s.views : s.views.filter((v) => v.viewerId === viewerId),
  };
}

export async function createStatus(userId: string, input: CreateStatus) {
  if (input.kind !== "text" && !input.attachmentId) throw badRequest("attachment_required");
  if (input.attachmentId) {
    const att = await prisma.messageAttachment.findUnique({ where: { id: input.attachmentId } });
    if (!att || att.uploaderId !== userId || !att.uploadedAt || att.messageId || att.kind !== "status_media") {
      throw badRequest("invalid_attachment");
    }
  }
  const status = await prisma.status.create({
    data: {
      userId,
      kind: input.kind,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      attachmentId: input.attachmentId ?? null,
      expiresAt: new Date(Date.now() + input.expiresInHours * 3600_000),
    },
    include: statusInclude,
  });
  const partnerId = await partnerIdOf(userId);
  emitToUsers([userId], "status:new", shape(status, userId));
  if (partnerId) {
    emitToUsers([partnerId], "status:new", shape(status, partnerId));
    const settings = await prisma.userSettings.findUnique({ where: { userId: partnerId } });
    if (settings?.statusNotifications ?? true) {
      const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
      void pushToUser(partnerId, { priority: "normal", collapseKey: "status", data: { type: "status", statusId: status.id, senderName: me.displayName } });
    }
  }
  return shape(status, userId);
}

export async function activeStatuses(userId: string) {
  const rows = await prisma.status.findMany({
    where: { deletedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    include: statusInclude,
  });
  return rows.map((s) => shape(s, userId));
}

export async function viewStatus(userId: string, statusId: string) {
  const s = await prisma.status.findUnique({ where: { id: statusId } });
  if (!s || s.deletedAt || s.expiresAt < new Date()) throw notFound("status_not_found");
  if (s.userId === userId) return; // own views are not recorded
  const view = await prisma.statusView.upsert({
    where: { statusId_viewerId: { statusId, viewerId: userId } },
    create: { statusId, viewerId: userId },
    update: {},
  });
  emitToUsers([s.userId], "status:viewed", { statusId, viewerId: userId, viewedAt: view.viewedAt });
}

async function removeStatus(statusId: string, attachmentId: string | null) {
  await prisma.status.update({ where: { id: statusId }, data: { deletedAt: new Date() } });
  if (attachmentId) {
    const att = await prisma.messageAttachment.update({ where: { id: attachmentId }, data: { deletedAt: new Date() } });
    await storage.remove(att.objectKey).catch(() => undefined);
  }
}

export async function deleteStatus(userId: string, statusId: string) {
  const s = await prisma.status.findUnique({ where: { id: statusId } });
  if (!s || s.deletedAt) throw notFound("status_not_found");
  if (s.userId !== userId) throw forbidden("not_owner", "You can only delete your own status");
  await removeStatus(s.id, s.attachmentId);
  const partnerId = await partnerIdOf(userId);
  emitToUsers([userId, ...(partnerId ? [partnerId] : [])], "status:deleted", { statusId });
}

/** Server-enforced expiry: removes expired statuses and their media. Returns count. */
export async function expireStatuses(now = new Date()) {
  const expired = await prisma.status.findMany({ where: { deletedAt: null, expiresAt: { lte: now } }, take: 500 });
  for (const s of expired) {
    await removeStatus(s.id, s.attachmentId);
    const partnerId = await partnerIdOf(s.userId);
    emitToUsers([s.userId, ...(partnerId ? [partnerId] : [])], "status:deleted", { statusId: s.id, reason: "expired" });
  }
  return expired.length;
}
