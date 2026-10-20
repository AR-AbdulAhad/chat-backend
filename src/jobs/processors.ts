import { prisma } from "../lib/prisma.js";
import { storage } from "../lib/storage.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { expireStatuses } from "../modules/statuses/service.js";
import { finishCall, removeRecording } from "../modules/calls/service.js";

export async function callTimeout(callId: string) {
  const call = await prisma.callRecord.findUnique({ where: { id: callId } });
  if (call?.state === "ringing") await finishCall(null, callId, "timeout");
}

/** Removes uploads that were reserved but never completed, or completed but never used. */
export async function cleanupUploads(now = new Date()) {
  const stale = await prisma.messageAttachment.findMany({
    where: {
      deletedAt: null,
      messageId: null,
      OR: [
        { uploadedAt: null, createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) } },
        { uploadedAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } },
      ],
    },
    take: 500,
  });
  let removed = 0;
  for (const a of stale) {
    // Still referenced by a status or recording? keep.
    const [status, rec] = await Promise.all([
      prisma.status.findUnique({ where: { attachmentId: a.id } }),
      prisma.callRecording.findUnique({ where: { attachmentId: a.id } }),
    ]);
    if ((status && !status.deletedAt) || (rec && !rec.deletedAt)) continue;
    await storage.remove(a.objectKey).catch(() => undefined);
    await prisma.messageAttachment.update({ where: { id: a.id }, data: { deletedAt: now } });
    removed++;
  }
  return removed;
}

/** Applies the recording retention policy and drops consent rows never uploaded. */
export async function cleanupRecordings(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.RECORDING_RETENTION_DAYS * 24 * 3600_000);
  const rows = await prisma.callRecording.findMany({
    where: {
      deletedAt: null,
      OR: [{ createdAt: { lt: cutoff } }, { attachmentId: null, createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) } }],
    },
    take: 500,
  });
  for (const r of rows) await removeRecording(r.id, r.attachmentId);
  return rows.length;
}

export async function cleanupTokens(now = new Date()) {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } }] },
  });
  await prisma.deviceSession.deleteMany({ where: { revokedAt: { lt: new Date(now.getTime() - 90 * 24 * 3600_000) } } });
  return count;
}

export async function processJob(name: string, data: any) {
  switch (name) {
    case "call-timeout":
      return callTimeout(data.callId);
    case "expire-statuses":
      return expireStatuses();
    case "cleanup-uploads":
      return cleanupUploads();
    case "cleanup-recordings":
      return cleanupRecordings();
    case "cleanup-tokens":
      return cleanupTokens();
    default:
      logger.warn({ name }, "unknown job");
  }
}
