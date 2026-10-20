import { prisma } from "../../lib/prisma.js";
import { isOnline } from "../../lib/presence.js";
import { notFound } from "../../lib/errors.js";
import type { User } from "../../generated/prisma/client.js";

export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    about: u.about,
    hasAvatar: Boolean(u.avatarObjectKey),
    avatarVersion: u.updatedAt.getTime(),
    createdAt: u.createdAt,
  };
}

/** The single shared conversation. Created once both accounts exist. */
export async function ensureConversation() {
  const users = await prisma.user.findMany({ select: { id: true } });
  if (users.length !== 2) return null;
  const existing = await prisma.conversation.findFirst({ include: { participants: true } });
  if (existing) return existing;
  try {
    return await prisma.conversation.create({
      data: { participants: { create: users.map((u) => ({ userId: u.id })) } },
      include: { participants: true },
    });
  } catch {
    return prisma.conversation.findFirst({ include: { participants: true } });
  }
}

export async function getConversationFor(userId: string) {
  const conv = await prisma.conversation.findFirst({
    where: { participants: { some: { userId } } },
    include: { participants: true },
  });
  if (!conv) throw notFound("no_conversation", "Your partner has not finished setting up their account yet");
  const partnerId = conv.participants.find((p) => p.userId !== userId)?.userId;
  if (!partnerId) throw notFound("no_partner");
  return { conversationId: conv.id, partnerId };
}

export async function partnerIdOf(userId: string) {
  const partner = await prisma.user.findFirst({ where: { id: { not: userId } }, select: { id: true } });
  return partner?.id ?? null;
}

/** Partner's profile, respecting reciprocal last-seen / online privacy settings. */
export async function partnerProfile(userId: string) {
  const partnerId = await partnerIdOf(userId);
  if (!partnerId) throw notFound("no_partner");
  const [me, partner] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { settings: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: partnerId }, include: { settings: true } }),
  ]);
  const shareLastSeen = (me.settings?.showLastSeen ?? true) && (partner.settings?.showLastSeen ?? true);
  const shareOnline = (me.settings?.showOnline ?? true) && (partner.settings?.showOnline ?? true);
  return {
    ...publicUser(partner),
    online: shareOnline ? await isOnline(partner.id) : null,
    lastSeenAt: shareLastSeen ? partner.lastSeenAt : null,
  };
}
