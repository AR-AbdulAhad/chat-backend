import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { authenticateToken, type AuthContext } from "../middleware/auth.js";
import { rooms, setIo, emitToUsers } from "../lib/realtime.js";
import { logger } from "../lib/logger.js";
import { HttpError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { isOnline, setForeground, socketConnected, socketDisconnected } from "../lib/presence.js";
import { partnerIdOf } from "../modules/users/service.js";
import * as messages from "../modules/messages/service.js";
import * as calls from "../modules/calls/service.js";
import { editSchema, receiptsSchema, sendSchema } from "../modules/messages/schemas.js";

type Ack = (res: { ok: true; data?: unknown } | { ok: false; error: { code: string; message?: string } }) => void;

/** Wraps a handler: validates the payload, runs it, and always answers the ack. */
function on<T extends z.ZodType>(socket: Socket, event: string, schema: T, fn: (ctx: AuthContext, data: z.infer<T>) => Promise<unknown>) {
  socket.on(event, async (raw: unknown, ack?: Ack) => {
    const reply: Ack = typeof ack === "function" ? ack : () => undefined;
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      reply({ ok: false, error: { code: "validation_failed", message: parsed.error.issues[0]?.message } });
      return;
    }
    try {
      // Re-check the session on every event so a revoked device stops immediately.
      const ctx = socket.data.auth as AuthContext;
      const session = await prisma.deviceSession.findUnique({ where: { id: ctx.sessionId }, select: { revokedAt: true } });
      if (!session || session.revokedAt) {
        reply({ ok: false, error: { code: "session_revoked" } });
        socket.disconnect(true);
        return;
      }
      reply({ ok: true, data: await fn(ctx, parsed.data) });
    } catch (err) {
      if (err instanceof HttpError) reply({ ok: false, error: { code: err.code, message: err.message } });
      else {
        logger.error({ err, event }, "socket handler failed");
        reply({ ok: false, error: { code: "internal_error" } });
      }
    }
  });
}

async function presencePayload(subjectId: string, viewerId: string) {
  const [subject, viewer] = await Promise.all([
    prisma.user.findUnique({ where: { id: subjectId }, include: { settings: true } }),
    prisma.userSettings.findUnique({ where: { userId: viewerId } }),
  ]);
  if (!subject) return null;
  const shareOnline = (subject.settings?.showOnline ?? true) && (viewer?.showOnline ?? true);
  const shareLastSeen = (subject.settings?.showLastSeen ?? true) && (viewer?.showLastSeen ?? true);
  return {
    userId: subjectId,
    online: shareOnline ? await isOnline(subjectId) : null,
    lastSeenAt: shareLastSeen ? subject.lastSeenAt : null,
  };
}

async function broadcastPresence(userId: string) {
  const partnerId = await partnerIdOf(userId);
  if (!partnerId) return;
  const payload = await presencePayload(userId, partnerId);
  if (payload) emitToUsers([partnerId], "presence:update", payload);
}

const uuid = z.string().uuid();

export function createSocketServer(http: HttpServer) {
  const io = new Server(http, {
    path: "/socket.io",
    serveClient: false,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 256 * 1024,
    cors: { origin: false },
    // Brief disconnects (tunnel, network switch) resume without losing events.
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: false },
  });

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined) ?? undefined;
      socket.data.auth = await authenticateToken(token);
      next();
    } catch {
      void audit("socket_auth_failed", { ip: socket.handshake.address });
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const ctx = socket.data.auth as AuthContext;
    // Join rooms synchronously so no event emitted right after "connect" is missed.
    void socket.join([rooms.user(ctx.userId), rooms.session(ctx.sessionId)]);
    // Foreground until the app says otherwise (it reports lifecycle changes).
    const ready = socketConnected(ctx.userId, socket.id)
      .then(() => setForeground(ctx.userId, true))
      .then(() => broadcastPresence(ctx.userId))
      .catch((err) => logger.error({ err }, "presence connect failed"));

    on(socket, "presence:state", z.object({ active: z.boolean() }), async ({ userId }, { active }) => {
      await setForeground(userId, active);
      if (!active) await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
      await broadcastPresence(userId);
    });

    on(socket, "presence:get", z.object({}), async ({ userId }) => {
      const partnerId = await partnerIdOf(userId);
      return partnerId ? presencePayload(partnerId, userId) : null;
    });

    on(socket, "typing", z.object({ active: z.boolean() }), async ({ userId }, { active }) => {
      const partnerId = await partnerIdOf(userId);
      if (!partnerId) return;
      const [mine, theirs] = await Promise.all([
        prisma.userSettings.findUnique({ where: { userId } }),
        prisma.userSettings.findUnique({ where: { userId: partnerId } }),
      ]);
      if ((mine?.typingIndicators ?? true) && (theirs?.typingIndicators ?? true)) {
        emitToUsers([partnerId], "typing", { userId, active });
      }
    });

    // Messaging
    on(socket, "message:send", sendSchema, async ({ userId }, data) => (await messages.sendMessage(userId, data)).message);
    on(socket, "message:edit", editSchema.extend({ id: uuid }), ({ userId }, d) => messages.editMessage(userId, d.id, d.ciphertext, d.nonce));
    on(socket, "message:delete", z.object({ id: uuid }), ({ userId }, d) => messages.deleteForEveryone(userId, d.id));
    on(socket, "message:react", z.object({ id: uuid, emoji: z.string().min(1).max(32).nullable() }), ({ userId }, d) => messages.react(userId, d.id, d.emoji));
    on(socket, "message:pin", z.object({ id: uuid, pinned: z.boolean() }), ({ userId }, d) => messages.pin(userId, d.id, d.pinned));
    on(socket, "message:receipts", receiptsSchema, ({ userId }, d) => messages.markReceipts(userId, d.messageIds, d.kind));
    on(socket, "message:read-all", z.object({}), ({ userId }) => messages.markAllRead(userId));
    on(
      socket,
      "message:sync",
      z.object({ since: z.string().regex(/^\d{1,19}$/).default("0"), limit: z.number().int().min(1).max(500).default(200) }),
      ({ userId }, d) => messages.syncMessages(userId, BigInt(d.since), d.limit),
    );

    // Live location: ephemeral position updates for an active live_location message.
    on(
      socket,
      "location:live",
      z.object({ messageId: uuid, ciphertext: z.string().min(16).max(4000), nonce: z.string().min(16).max(64) }),
      async ({ userId }, d) => {
        const msg = await prisma.message.findUnique({ where: { id: d.messageId } });
        if (!msg || msg.senderId !== userId || msg.type !== "live_location" || msg.deletedAt) throw new HttpError(400, "invalid_live_location");
        const partnerId = await partnerIdOf(userId);
        if (partnerId) emitToUsers([partnerId], "location:live", { messageId: d.messageId, ciphertext: d.ciphertext, nonce: d.nonce, at: new Date() });
      },
    );

    // Calls
    on(socket, "call:start", z.object({ type: z.enum(["voice", "video"]) }), ({ userId }, d) => calls.startCall(userId, d.type));
    on(socket, "call:accept", z.object({ callId: uuid }), ({ userId }, d) => calls.acceptCall(userId, d.callId));
    on(
      socket,
      "call:end",
      z.object({ callId: uuid, reason: z.enum(["hangup", "rejected", "busy", "failed"]).default("hangup") }),
      ({ userId }, d) => calls.finishCall(userId, d.callId, d.reason),
    );
    on(
      socket,
      "call:signal",
      z.object({
        callId: uuid,
        data: z.union([
          z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(20_000) }),
          z.object({ type: z.literal("candidate"), candidate: z.string().max(2000), sdpMid: z.string().max(64).nullable(), sdpMLineIndex: z.number().int().nullable() }),
          z.object({ type: z.literal("media"), audio: z.boolean(), video: z.boolean() }),
          z.object({ type: z.literal("restart") }),
        ]),
      }),
      ({ userId }, d) => calls.relaySignal(userId, d.callId, d.data),
    );
    on(socket, "call:recording-request", z.object({ callId: uuid }), ({ userId }, d) => calls.requestRecording(userId, d.callId));
    on(socket, "call:recording-consent", z.object({ callId: uuid, accepted: z.boolean() }), ({ userId }, d) =>
      calls.answerRecordingRequest(userId, d.callId, d.accepted),
    );
    on(socket, "call:recording-stop", z.object({ callId: uuid }), ({ userId }, d) => calls.stopRecording(userId, d.callId));

    socket.on("disconnect", async () => {
      await ready;
      const left = await socketDisconnected(ctx.userId, socket.id);
      if (left === 0) {
        await prisma.user.update({ where: { id: ctx.userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
        void broadcastPresence(ctx.userId);
        const partnerId = await partnerIdOf(ctx.userId);
        if (partnerId) emitToUsers([partnerId], "typing", { userId: ctx.userId, active: false });
      }
    });
  });

  setIo(io);
  return io;
}
