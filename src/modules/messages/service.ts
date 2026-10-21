import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { emitToUsers } from "../../lib/realtime.js";
import { isOnline } from "../../lib/presence.js";
import { storage } from "../../lib/storage.js";
import { pushToUser } from "../notifications/service.js";
import { getConversationFor } from "../users/service.js";
import type { MessageType, Prisma } from "../../generated/prisma/client.js";

export const messageInclude = {
  attachments: { where: { deletedAt: null }, select: { id: true, kind: true, sizeBytes: true } },
  receipts: true,
  reactions: { select: { userId: true, emoji: true, createdAt: true } },
} satisfies Prisma.MessageInclude;

type FullMessage = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

async function receiptVisibility(conversationUserIds: string[]) {
  const settings = await prisma.userSettings.findMany({ where: { userId: { in: conversationUserIds } }, select: { readReceipts: true } });
  return settings.length === conversationUserIds.length && settings.every((s) => s.readReceipts);
}

/** Shapes a message for one viewer. Ciphertext is passed through untouched. */
export function serialize(m: FullMessage, viewerId: string, showReadReceipts: boolean) {
  const r = m.receipts.find((x) => x.userId !== m.senderId);
  const deleted = Boolean(m.deletedAt);
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    clientId: m.clientId,
    type: m.type,
    ciphertext: deleted ? null : m.ciphertext,
    nonce: deleted ? null : m.nonce,
    encVersion: m.encVersion,
    replyToId: m.replyToId,
    forwarded: m.forwarded,
    statusId: m.statusId,
    pinnedAt: m.pinnedAt,
    pinnedById: m.pinnedById,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    createdAt: m.createdAt,
    syncSeq: m.syncSeq.toString(),
    attachments: deleted ? [] : m.attachments.map((a) => ({ id: a.id, kind: a.kind, sizeBytes: Number(a.sizeBytes) })),
    reactions: m.reactions,
    deliveredAt: r?.deliveredAt ?? null,
    // The reader's own read state is always visible to them; the sender sees it only if both share receipts.
    readAt: r ? (viewerId === r.userId || showReadReceipts ? r.readAt : null) : null,
  };
}

export type SerializedMessage = ReturnType<typeof serialize>;

async function emitMessage(event: string, messageId: string, userIds: string[]) {
  const m = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: messageInclude });
  const show = await receiptVisibility(userIds);
  for (const uid of userIds) emitToUsers([uid], event, serialize(m, uid, show));
  return m;
}

export interface SendInput {
  clientId: string;
  type: MessageType;
  ciphertext: string;
  nonce: string;
  encVersion?: number;
  replyToId?: string | null;
  forwarded?: boolean;
  statusId?: string | null;
  attachmentIds?: string[];
}

export async function sendMessage(userId: string, input: SendInput) {
  const { conversationId, partnerId } = await getConversationFor(userId);

  // Idempotency: retries with the same clientId return the original message.
  const existing = await prisma.message.findUnique({
    where: { senderId_clientId: { senderId: userId, clientId: input.clientId } },
    include: messageInclude,
  });
  if (existing) {
    return { message: serialize(existing, userId, await receiptVisibility([userId, partnerId])), duplicate: true };
  }

  if (input.replyToId) {
    const target = await prisma.message.findUnique({ where: { id: input.replyToId }, select: { conversationId: true } });
    if (!target || target.conversationId !== conversationId) throw badRequest("invalid_reply_target");
  }
  if (input.statusId) {
    const status = await prisma.status.findUnique({ where: { id: input.statusId } });
    if (!status || status.userId !== partnerId || status.deletedAt || status.expiresAt < new Date()) {
      throw badRequest("invalid_status_reply");
    }
  }
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (attachmentIds.length > 10) throw badRequest("too_many_attachments");
  if (attachmentIds.length) {
    const atts = await prisma.messageAttachment.findMany({ where: { id: { in: attachmentIds } } });
    const valid = atts.length === attachmentIds.length && atts.every((a) => a.uploaderId === userId && a.uploadedAt && !a.messageId && !a.deletedAt);
    if (!valid) throw badRequest("invalid_attachments", "Attachments must be uploaded by you and not already used");
  }

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          clientId: input.clientId,
          type: input.type,
          ciphertext: input.ciphertext,
          nonce: input.nonce,
          encVersion: input.encVersion ?? 1,
          replyToId: input.replyToId ?? null,
          forwarded: input.forwarded ?? false,
          statusId: input.statusId ?? null,
          receipts: { create: { userId: partnerId } },
        },
      });
      if (attachmentIds.length) {
        const linked = await tx.messageAttachment.updateMany({ where: { id: { in: attachmentIds }, messageId: null }, data: { messageId: msg.id } });
        if (linked.count !== attachmentIds.length) throw conflict("attachment_race");
      }
      return msg;
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Lost a race with a concurrent retry of the same clientId.
      const again = await prisma.message.findUniqueOrThrow({
        where: { senderId_clientId: { senderId: userId, clientId: input.clientId } },
        include: messageInclude,
      });
      return { message: serialize(again, userId, await receiptVisibility([userId, partnerId])), duplicate: true };
    }
    throw err;
  }

  const full = await emitMessage("message:new", created.id, [userId, partnerId]);

  const sender = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
  const settings = await prisma.userSettings.findUnique({ where: { userId: partnerId } });
  const small = (input.ciphertext.length ?? 0) <= 3000;
  void pushToUser(partnerId, {
    priority: "high",
    collapseKey: `msg_${created.id}`,
    data: {
      type: "message",
      messageId: created.id,
      clientId: input.clientId,
      conversationId,
      senderId: userId,
      senderName: sender.displayName,
      msgType: input.type,
      preview: settings?.notificationPreview ?? "full",
      createdAt: created.createdAt.toISOString(),
      // Ciphertext lets the device decrypt a preview locally; the server cannot read it.
      ...(small ? { ciphertext: input.ciphertext, nonce: input.nonce, encVersion: String(input.encVersion ?? 1) } : {}),
    },
  });
  return { message: serialize(full, userId, await receiptVisibility([userId, partnerId])), duplicate: false };
}

async function loadOwnConversationMessage(userId: string, messageId: string) {
  const { conversationId, partnerId } = await getConversationFor(userId);
  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.conversationId !== conversationId) throw notFound("message_not_found");
  return { msg, conversationId, partnerId };
}

export async function markReceipts(userId: string, messageIds: string[], kind: "delivered" | "read") {
  const { conversationId, partnerId } = await getConversationFor(userId);
  const ids = [...new Set(messageIds)].slice(0, 500);
  if (ids.length === 0) return 0;
  const now = new Date();
  const where = {
    userId,
    messageId: { in: ids },
    message: { conversationId, senderId: partnerId },
    ...(kind === "delivered" ? { deliveredAt: null } : { readAt: null }),
  };
  const targets = await prisma.messageReceipt.findMany({ where, select: { messageId: true } });
  if (targets.length === 0) return 0;
  const targetIds = targets.map((t) => t.messageId);
  await prisma.$transaction([
    prisma.messageReceipt.updateMany({
      where: { userId, messageId: { in: targetIds } },
      data: kind === "delivered" ? { deliveredAt: now } : { readAt: now },
    }),
    // read implies delivered
    ...(kind === "read"
      ? [prisma.messageReceipt.updateMany({ where: { userId, messageId: { in: targetIds }, deliveredAt: null }, data: { deliveredAt: now } })]
      : []),
    prisma.message.updateMany({ where: { id: { in: targetIds } }, data: { syncSeq: 0 } }), // trigger assigns a new seq
  ]);
  const show = await receiptVisibility([userId, partnerId]);
  emitToUsers([partnerId], "receipt:update", {
    messageIds: targetIds,
    deliveredAt: now,
    readAt: kind === "read" && show ? now : null,
  });
  emitToUsers([userId], "receipt:update", { messageIds: targetIds, deliveredAt: now, readAt: kind === "read" ? now : null, self: true });
  return targetIds.length;
}

/** Marks every unread incoming message as read (opening the chat). */
export async function markAllRead(userId: string) {
  const { partnerId } = await getConversationFor(userId);
  const unread = await prisma.messageReceipt.findMany({
    where: { userId, readAt: null, message: { senderId: partnerId } },
    select: { messageId: true },
    take: 500,
  });
  return markReceipts(userId, unread.map((u) => u.messageId), "read");
}

const EDITABLE: MessageType[] = ["text", "link"];

export async function editMessage(userId: string, messageId: string, ciphertext: string, nonce: string) {
  const { msg, partnerId } = await loadOwnConversationMessage(userId, messageId);
  if (msg.senderId !== userId) throw forbidden("not_sender", "You can only edit your own messages");
  if (msg.deletedAt) throw badRequest("message_deleted");
  if (!EDITABLE.includes(msg.type)) throw badRequest("not_editable", "Only text messages can be edited");
  if (Date.now() - msg.createdAt.getTime() > env.MESSAGE_EDIT_WINDOW_MIN * 60_000) {
    throw badRequest("edit_window_passed", `Messages can be edited for ${env.MESSAGE_EDIT_WINDOW_MIN} minutes`);
  }
  await prisma.message.update({ where: { id: messageId }, data: { ciphertext, nonce, editedAt: new Date() } });
  const m = await emitMessage("message:updated", messageId, [userId, partnerId]);
  return serialize(m, userId, await receiptVisibility([userId, partnerId]));
}

/**
 * Delete for everyone: the sender only, within the delete window. A visible
 * tombstone ("This message was deleted") remains for both people — nothing is
 * removed silently from the shared history.
 */
export async function deleteForEveryone(userId: string, messageId: string) {
  const { msg, partnerId } = await loadOwnConversationMessage(userId, messageId);
  if (msg.senderId !== userId) throw forbidden("not_sender", "You can only delete your own messages for everyone");
  if (msg.deletedAt) return;
  if (Date.now() - msg.createdAt.getTime() > env.MESSAGE_DELETE_WINDOW_HOURS * 3600_000) {
    throw badRequest("delete_window_passed", `Messages can be deleted for everyone within ${env.MESSAGE_DELETE_WINDOW_HOURS} hours`);
  }
  const atts = await prisma.messageAttachment.findMany({ where: { messageId, deletedAt: null } });
  await prisma.$transaction([
    prisma.message.update({ where: { id: messageId }, data: { ciphertext: null, nonce: null, deletedAt: new Date(), pinnedAt: null, pinnedById: null } }),
    prisma.reaction.deleteMany({ where: { messageId } }),
    prisma.messageAttachment.updateMany({ where: { messageId }, data: { deletedAt: new Date() } }),
  ]);
  await Promise.all(atts.map((a) => storage.remove(a.objectKey).catch(() => undefined)));
  await emitMessage("message:updated", messageId, [userId, partnerId]);
}

export async function react(userId: string, messageId: string, emoji: string | null) {
  const { msg, partnerId } = await loadOwnConversationMessage(userId, messageId);
  if (msg.deletedAt) throw badRequest("message_deleted");
  if (emoji) {
    await prisma.reaction.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId, emoji },
      update: { emoji, createdAt: new Date() },
    });
  } else {
    await prisma.reaction.deleteMany({ where: { messageId, userId } });
  }
  await prisma.message.update({ where: { id: messageId }, data: { syncSeq: 0 } });
  await emitMessage("message:updated", messageId, [userId, partnerId]);
}

export async function pin(userId: string, messageId: string, pinned: boolean) {
  const { msg, partnerId } = await loadOwnConversationMessage(userId, messageId);
  if (msg.deletedAt) throw badRequest("message_deleted");
  if (pinned) {
    const count = await prisma.message.count({ where: { conversationId: msg.conversationId, pinnedAt: { not: null } } });
    if (count >= 10 && !msg.pinnedAt) throw badRequest("too_many_pins", "Up to 10 messages can be pinned");
  }
  await prisma.message.update({
    where: { id: messageId },
    data: pinned ? { pinnedAt: new Date(), pinnedById: userId } : { pinnedAt: null, pinnedById: null },
  });
  await emitMessage("message:updated", messageId, [userId, partnerId]);
}

export async function listMessages(userId: string, opts: { before?: Date; after?: Date; limit: number; pinned?: boolean }) {
  const { conversationId, partnerId } = await getConversationFor(userId);
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      ...(opts.before || opts.after ? { createdAt: { ...(opts.before ? { lt: opts.before } : {}), ...(opts.after ? { gte: opts.after } : {}) } } : {}),
      ...(opts.pinned ? { pinnedAt: { not: null } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    include: messageInclude,
  });
  const show = await receiptVisibility([userId, partnerId]);
  const hasMore = rows.length > opts.limit;
  return { messages: rows.slice(0, opts.limit).map((m) => serialize(m, userId, show)), hasMore };
}

/** Every message created or changed after `since` (ascending). Drives reconnection sync. */
export async function syncMessages(userId: string, since: bigint, limit: number) {
  const { conversationId, partnerId } = await getConversationFor(userId);
  const rows = await prisma.message.findMany({
    where: { conversationId, syncSeq: { gt: since } },
    orderBy: { syncSeq: "asc" },
    take: limit + 1,
    include: messageInclude,
  });
  const show = await receiptVisibility([userId, partnerId]);
  const page = rows.slice(0, limit);
  return {
    messages: page.map((m) => serialize(m, userId, show)),
    nextSince: page.length ? page[page.length - 1].syncSeq.toString() : since.toString(),
    hasMore: rows.length > limit,
  };
}

export async function conversationSummary(conversationId: string, userId: string) {
  const [unreadCount, last, pinnedCount] = await Promise.all([
    prisma.messageReceipt.count({ where: { userId, readAt: null, message: { conversationId, deletedAt: null } } }),
    prisma.message.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" }, include: messageInclude }),
    prisma.message.count({ where: { conversationId, pinnedAt: { not: null } } }),
  ]);
  const participants = await prisma.conversationParticipant.findMany({ where: { conversationId }, select: { userId: true } });
  const show = await receiptVisibility(participants.map((p) => p.userId));
  return { unreadCount, pinnedCount, lastMessage: last ? serialize(last, userId, show) : null };
}
