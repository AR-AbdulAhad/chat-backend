import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage.js";
import { maxBytesForKind } from "../../config/env.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import type { AttachmentKind } from "../../generated/prisma/client.js";
import { getConversationFor } from "../users/service.js";

/** Step 1: reserve an object and hand back a short-lived upload URL. */
export async function createUpload(userId: string, kind: AttachmentKind, sizeBytes: number, baseUrl?: string) {
  if (kind === "avatar") throw badRequest("use_avatar_endpoint", "Upload profile photos with PUT /users/me/avatar");
  const max = maxBytesForKind[kind];
  if (!max || sizeBytes > max) throw badRequest("file_too_large", `Maximum size for ${kind} is ${Math.floor(max / 1048576)} MB`, { maxBytes: max });
  const id = randomUUID();
  const objectKey = `media/${userId}/${id}`;
  await prisma.messageAttachment.create({ data: { id, uploaderId: userId, kind, objectKey, sizeBytes: BigInt(sizeBytes) } });
  return {
    attachmentId: id,
    uploadUrl: await storage.presignPut(objectKey, sizeBytes, baseUrl),
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(sizeBytes) },
  };
}

/** Step 2: confirm the object really exists with the declared size. */
export async function completeUpload(userId: string, attachmentId: string) {
  const att = await prisma.messageAttachment.findUnique({ where: { id: attachmentId } });
  if (!att || att.uploaderId !== userId || att.deletedAt) throw notFound("attachment_not_found");
  if (att.uploadedAt) return { attachmentId, sizeBytes: Number(att.sizeBytes) };
  const head = await storage.head(att.objectKey);
  if (!head) throw badRequest("upload_missing", "The file has not been uploaded yet");
  if (head.sizeBytes !== Number(att.sizeBytes)) {
    await storage.remove(att.objectKey).catch(() => undefined);
    await prisma.messageAttachment.update({ where: { id: att.id }, data: { deletedAt: new Date() } });
    throw badRequest("size_mismatch", "Uploaded size does not match the declared size");
  }
  await prisma.messageAttachment.update({ where: { id: att.id }, data: { uploadedAt: new Date() } });
  return { attachmentId, sizeBytes: head.sizeBytes };
}

/**
 * Download authorization: the uploader, or the other participant once the blob is
 * attached to a message in their conversation, an active status, or a call recording.
 */
export async function downloadUrl(userId: string, attachmentId: string, baseUrl?: string) {
  const att = await prisma.messageAttachment.findUnique({ where: { id: attachmentId } });
  if (!att || att.deletedAt || !att.uploadedAt) throw notFound("attachment_not_found");
  if (att.uploaderId !== userId) {
    let allowed = false;
    if (att.messageId) {
      const { conversationId } = await getConversationFor(userId);
      const msg = await prisma.message.findUnique({ where: { id: att.messageId }, select: { conversationId: true, deletedAt: true } });
      allowed = Boolean(msg && msg.conversationId === conversationId && !msg.deletedAt);
    }
    if (!allowed) {
      const status = await prisma.status.findUnique({ where: { attachmentId } });
      allowed = Boolean(status && !status.deletedAt && status.expiresAt > new Date());
    }
    if (!allowed) {
      const rec = await prisma.callRecording.findUnique({ where: { attachmentId }, include: { call: true } });
      allowed = Boolean(rec && !rec.deletedAt && (rec.call.callerId === userId || rec.call.calleeId === userId));
    }
    if (!allowed) throw forbidden("not_allowed");
  }
  return { url: await storage.presignGet(att.objectKey, baseUrl), sizeBytes: Number(att.sizeBytes), kind: att.kind };
}
