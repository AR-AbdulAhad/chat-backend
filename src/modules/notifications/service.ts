import { prisma } from "../../lib/prisma.js";
import { pushSender, type PushPayload } from "../../lib/push.js";
import { logger } from "../../lib/logger.js";

/** Sends a data-only push to every active device of a user. Never contains plaintext. */
export async function pushToUser(userId: string, payload: PushPayload) {
  const tokens = await prisma.pushToken.findMany({
    where: { invalidAt: null, session: { userId, revokedAt: null, expiresAt: { gt: new Date() } } },
    select: { id: true, token: true },
  });
  const results = await Promise.all(
    tokens.map(async (t) => {
      const r = await pushSender.send(t.token, payload);
      if (r === "invalid_token") await prisma.pushToken.delete({ where: { id: t.id } }).catch(() => undefined);
      return r;
    }),
  );
  if (tokens.length === 0) logger.debug({ userId }, "no push tokens registered");
  return results;
}

export async function registerPushToken(sessionId: string, token: string) {
  // A token belongs to exactly one session; move it if the device re-registered.
  await prisma.pushToken.upsert({
    where: { token },
    create: { sessionId, token },
    update: { sessionId, invalidAt: null },
  });
  // Keep only the newest token per session.
  await prisma.pushToken.deleteMany({ where: { sessionId, token: { not: token } } });
}

export async function unregisterPushToken(sessionId: string, token: string) {
  await prisma.pushToken.deleteMany({ where: { sessionId, token } });
}
