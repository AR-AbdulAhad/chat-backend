import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import { notFound } from "../../lib/errors.js";
import { emitToUsers } from "../../lib/realtime.js";
import { audit } from "../../lib/audit.js";
import { partnerIdOf } from "../users/service.js";
import { b64 } from "../messages/schemas.js";

/**
 * Public-key directory for end-to-end encryption. The server stores only
 * X25519 public keys and an optional passphrase-encrypted private-key backup.
 */
export const keysRouter = Router();
keysRouter.use(requireAuth);

const shapeKey = (k: { publicKey: string; createdAt: Date; id: string }) => ({ id: k.id, publicKey: k.publicKey, createdAt: k.createdAt });

keysRouter.put(
  "/identity",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const { publicKey } = parse(z.object({ publicKey: b64.min(43).max(64) }), req.body);
    const current = await prisma.identityKey.findFirst({ where: { userId, revokedAt: null } });
    if (current?.publicKey === publicKey) {
      res.json(shapeKey(current));
      return;
    }
    const key = await prisma.$transaction(async (tx) => {
      await tx.identityKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return tx.identityKey.create({ data: { userId, publicKey } });
    });
    await audit("identity_key_rotated", { userId, meta: { hadPrevious: Boolean(current) } });
    const partnerId = await partnerIdOf(userId);
    // The partner's app shows "security code changed" so a key swap is never silent.
    if (partnerId) emitToUsers([partnerId], "keys:changed", { userId, ...shapeKey(key) });
    res.json(shapeKey(key));
  }),
);

keysRouter.get(
  "/me",
  ah(async (req, res) => {
    const key = await prisma.identityKey.findFirst({ where: { userId: authOf(req).userId, revokedAt: null } });
    if (!key) throw notFound("no_identity_key");
    res.json(shapeKey(key));
  }),
);

keysRouter.get(
  "/partner",
  ah(async (req, res) => {
    const partnerId = await partnerIdOf(authOf(req).userId);
    const key = partnerId ? await prisma.identityKey.findFirst({ where: { userId: partnerId, revokedAt: null } }) : null;
    if (!key) throw notFound("partner_has_no_key", "Your partner has not opened Amai yet");
    res.json({ userId: partnerId, ...shapeKey(key) });
  }),
);

/** Every key a user has ever published, so old messages remain decryptable. */
keysRouter.get(
  "/history",
  ah(async (req, res) => {
    const keys = await prisma.identityKey.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, userId: true, publicKey: true, createdAt: true, revokedAt: true } });
    res.json({ keys });
  }),
);

const backupSchema = z.object({
  ciphertext: b64.min(16).max(4096),
  nonce: b64.min(16).max(64),
  salt: b64.min(16).max(64),
  kdfParams: z.object({ algorithm: z.literal("argon2id"), memoryKiB: z.number().int().min(19456).max(1048576), iterations: z.number().int().min(2).max(10), parallelism: z.number().int().min(1).max(8) }),
});

keysRouter.put(
  "/backup",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(backupSchema, req.body);
    await prisma.keyBackup.upsert({ where: { userId }, create: { userId, ...body }, update: body });
    await audit("key_backup_updated", { userId });
    res.status(204).end();
  }),
);

keysRouter.get(
  "/backup",
  ah(async (req, res) => {
    const backup = await prisma.keyBackup.findUnique({ where: { userId: authOf(req).userId } });
    if (!backup) throw notFound("no_backup");
    res.json({ ciphertext: backup.ciphertext, nonce: backup.nonce, salt: backup.salt, kdfParams: backup.kdfParams, updatedAt: backup.updatedAt });
  }),
);

keysRouter.delete(
  "/backup",
  ah(async (req, res) => {
    await prisma.keyBackup.deleteMany({ where: { userId: authOf(req).userId } });
    res.status(204).end();
  }),
);
