import type { Server } from "socket.io";

let io: Server | null = null;

export function setIo(server: Server) {
  io = server;
}

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  session: (sessionId: string) => `session:${sessionId}`,
};

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(rooms.user(userId)).emit(event, payload);
}

export function emitToUsers(userIds: string[], event: string, payload: unknown) {
  if (!io || userIds.length === 0) return;
  io.to(userIds.map(rooms.user)).emit(event, payload);
}

/** Force-disconnects every socket that belongs to a revoked session. */
export function disconnectSession(sessionId: string, reason: string) {
  if (!io) return;
  io.to(rooms.session(sessionId)).emit("session:revoked", { reason });
  io.in(rooms.session(sessionId)).disconnectSockets(true);
}
