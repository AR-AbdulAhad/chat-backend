// Redis has been removed in favor of direct PostgreSQL + in-memory state.
// This stub is kept only to prevent breakage if referenced.
export const redis = {
  ping: async () => "PONG",
  quit: async () => {},
  disconnect: () => {},
} as any;

export function createRedis() {
  return redis;
}
