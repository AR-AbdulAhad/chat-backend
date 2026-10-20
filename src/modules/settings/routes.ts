import { Router } from "express";
import { z } from "zod";
import { ah } from "../../middleware/errors.js";
import { parse } from "../../middleware/validate.js";
import { authOf, requireAuth } from "../../middleware/auth.js";
import { prisma } from "../../lib/prisma.js";
import { emitToUsers } from "../../lib/realtime.js";
import { partnerIdOf } from "../users/service.js";
import { registerPushToken, unregisterPushToken } from "../notifications/service.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

async function load(userId: string) {
  const [settings, theme] = await Promise.all([
    prisma.userSettings.upsert({ where: { userId }, create: { userId }, update: {} }),
    prisma.themePreference.upsert({ where: { userId }, create: { userId }, update: {} }),
  ]);
  const { userId: _a, ...s } = settings;
  const { userId: _b, ...t } = theme;
  return { settings: s, theme: t };
}

settingsRouter.get(
  "/",
  ah(async (req, res) => {
    res.json(await load(authOf(req).userId));
  }),
);

const sound = z.string().regex(/^[a-z0-9_]{1,40}$/);
const settingsSchema = z
  .object({
    showLastSeen: z.boolean(),
    showOnline: z.boolean(),
    readReceipts: z.boolean(),
    typingIndicators: z.boolean(),
    notificationPreview: z.enum(["full", "sender_only", "hidden"]),
    messageSound: sound,
    callRingtone: sound,
    vibrate: z.boolean(),
    statusNotifications: z.boolean(),
    deliveryNotifications: z.boolean(),
    autoDownload: z.object({
      wifi: z.array(z.enum(["image", "voice", "video", "audio", "document"])),
      mobile: z.array(z.enum(["image", "voice", "video", "audio", "document"])),
    }),
    mediaQuality: z.enum(["data_saver", "standard", "hd"]),
  })
  .partial();

settingsRouter.patch(
  "/",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(settingsSchema, req.body);
    await prisma.userSettings.upsert({ where: { userId }, create: { userId, ...body }, update: body });
    if (["showLastSeen", "showOnline", "readReceipts", "typingIndicators"].some((k) => k in body)) {
      const partnerId = await partnerIdOf(userId);
      // Privacy settings are reciprocal; both sides refresh what they can see.
      emitToUsers([userId, ...(partnerId ? [partnerId] : [])], "privacy:changed", { userId });
    }
    res.json(await load(userId));
  }),
);

const themeSchema = z
  .object({
    mode: z.enum(["system", "light", "dark"]),
    accent: z.enum(["rose", "saffron", "sage", "lagoon", "lilac"]),
    bubbleStyle: z.enum(["rounded", "soft", "classic"]),
    fontScale: z.number().min(0.8).max(1.4),
    wallpaper: z.string().regex(/^(none|color:#[0-9a-fA-F]{6}|preset:[a-z0-9_]{1,40}|local)$/),
    haptics: z.boolean(),
  })
  .partial();

settingsRouter.patch(
  "/theme",
  ah(async (req, res) => {
    const { userId } = authOf(req);
    const body = parse(themeSchema, req.body);
    await prisma.themePreference.upsert({ where: { userId }, create: { userId, ...body }, update: body });
    res.json(await load(userId));
  }),
);

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

devicesRouter.get(
  "/",
  ah(async (req, res) => {
    const { userId, sessionId } = authOf(req);
    const sessions = await prisma.deviceSession.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, deviceName: true, platform: true, createdAt: true, lastUsedAt: true },
    });
    res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === sessionId })) });
  }),
);

devicesRouter.put(
  "/push-token",
  ah(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(4096) }), req.body);
    await registerPushToken(authOf(req).sessionId, token);
    res.status(204).end();
  }),
);

devicesRouter.delete(
  "/push-token",
  ah(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(4096) }), req.body);
    await unregisterPushToken(authOf(req).sessionId, token);
    res.status(204).end();
  }),
);
