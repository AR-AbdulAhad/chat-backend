import express, { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { emitToUsers } from "../../lib/realtime.js";
import { getConversationFor, partnerIdOf, partnerProfile, publicUser } from "./service.js";
import { conversationSummary } from "../messages/service.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get(
  "/me",
  ah(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: authOf(req).userId } });
    res.json(publicUser(user));
  }),
);

usersRouter.get(
  "/partner",
  ah(async (req, res) => {
    res.json(await partnerProfile(authOf(req).userId));
  }),
);

usersRouter.patch(
  "/me",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(
      z.object({ displayName: z.string().trim().min(1).max(60).optional(), about: z.string().trim().max(280).optional() }),
      req.body,
    );
    const user = await prisma.user.update({ where: { id: userId }, data: body });
    const partnerId = await partnerIdOf(userId);
    emitToUsers([userId, ...(partnerId ? [partnerId] : [])], "profile:updated", publicUser(user));
    res.json(publicUser(user));
  }),
);

/** Detect real image type from magic bytes; never trust the client's Content-Type. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

usersRouter.put(
  "/me/avatar",
  express.raw({ type: () => true, limit: "5mb" }),
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("empty_body");
    const type = sniffImage(body);
    if (!type) throw badRequest("unsupported_image", "Profile photo must be JPEG, PNG or WebP");
    const old = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarObjectKey: true } });
    const key = `avatars/${userId}/${Date.now()}`;
    await storage.put(key, body, type);
    const user = await prisma.user.update({ where: { id: userId }, data: { avatarObjectKey: key } });
    if (old.avatarObjectKey) await storage.remove(old.avatarObjectKey).catch(() => undefined);
    const partnerId = await partnerIdOf(userId);
    emitToUsers([userId, ...(partnerId ? [partnerId] : [])], "profile:updated", publicUser(user));
    res.json(publicUser(user));
  }),
);

usersRouter.delete(
  "/me/avatar",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const old = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarObjectKey: true } });
    const user = await prisma.user.update({ where: { id: userId }, data: { avatarObjectKey: null } });
    if (old.avatarObjectKey) await storage.remove(old.avatarObjectKey).catch(() => undefined);
    const partnerId = await partnerIdOf(userId);
    emitToUsers([userId, ...(partnerId ? [partnerId] : [])], "profile:updated", publicUser(user));
    res.json(publicUser(user));
  }),
);

/** Short-lived URL for either user's avatar (only the two accounts can call this). */
usersRouter.get(
  "/:id/avatar-url",
  ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const user = await prisma.user.findUnique({ where: { id }, select: { avatarObjectKey: true } });
    if (!user?.avatarObjectKey) throw notFound("no_avatar");
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json({ url: await storage.presignGet(user.avatarObjectKey, baseUrl) });
  }),
);

export const conversationRouter = Router();
conversationRouter.use(requireAuth);
conversationRouter.get(
  "/",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const { conversationId, partnerId } = await getConversationFor(userId);
    res.json({ id: conversationId, partnerId, ...(await conversationSummary(conversationId, userId)) });
  }),
);
