// In-memory presence tracking (zero Redis dependency)
const userSockets = new Map<string, Set<string>>();
const foregroundUsers = new Set<string>();

export async function socketConnected(userId: string, socketId: string): Promise<void> {
  let sockets = userSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    userSockets.set(userId, sockets);
  }
  sockets.add(socketId);
}

export async function socketDisconnected(userId: string, socketId: string): Promise<number> {
  const sockets = userSockets.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      userSockets.delete(userId);
      foregroundUsers.delete(userId);
      return 0;
    }
    return sockets.size;
  }
  return 0;
}

export async function setForeground(userId: string, active: boolean): Promise<void> {
  if (active) foregroundUsers.add(userId);
  else foregroundUsers.delete(userId);
}

/** "Online" = app is open in the foreground with a live socket. */
export async function isOnline(userId: string): Promise<boolean> {
  const sockets = userSockets.get(userId);
  return foregroundUsers.has(userId) && (sockets ? sockets.size > 0 : false);
}

export async function hasLiveSocket(userId: string): Promise<boolean> {
  const sockets = userSockets.get(userId);
  return sockets ? sockets.size > 0 : false;
}

export function resetPresence(): void {
  userSockets.clear();
  foregroundUsers.clear();
}
