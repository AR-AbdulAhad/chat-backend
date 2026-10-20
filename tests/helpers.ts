import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { io as ioClient, type Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { createSocketServer } from "../src/sockets/index.js";
import { prisma } from "../src/lib/prisma.js";
import { resetPresence } from "../src/lib/presence.js";
import { setStorage, type Storage } from "../src/lib/storage.js";
import { setPushSender, type PushPayload } from "../src/lib/push.js";
import { setupCode, sha256 } from "../src/lib/tokens.js";
import { startWorker, stopWorker } from "../src/jobs/runner.js";
import { closeQueue } from "../src/jobs/queue.js";

export const objects = new Map<string, number>();
export const fakeStorage: Storage = {
  presignPut: async (key) => `https://storage.test/${key}?sig=put`,
  presignGet: async (key) => `https://storage.test/${key}?sig=get`,
  head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)! } : null),
  put: async (key, body) => void objects.set(key, body.length),
  remove: async (key) => void objects.delete(key),
};
export const pushes: { token: string; payload: PushPayload }[] = [];

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

let http: Server;
export let baseUrl = "";
export const api = () => request(baseUrl);

export async function startTestServer() {
  setStorage(fakeStorage);
  setPushSender({ send: async (token, payload) => (pushes.push({ token, payload }), "ok") });
  const app = createApp();
  http = createServer(app);
  createSocketServer(http);
  await startWorker();
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

export async function stopTestServer() {
  await stopWorker();
  await closeQueue();
  await new Promise((r) => http.close(r));
}

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE audit_events, call_recordings, call_records, status_views, statuses, reactions, message_receipts,
    message_attachments, messages, conversation_participants, conversations, key_backups, identity_keys, push_tokens,
    refresh_tokens, device_sessions, user_settings, theme_preferences, users, authorized_accounts CASCADE`);
  resetPresence();
  objects.clear();
  pushes.length = 0;
}

/** Provisions a slot exactly like `npm run provision` and returns the one-time code. */
export async function invite(slot: number, email: string) {
  const code = setupCode();
  await prisma.authorizedAccount.upsert({
    where: { slot },
    create: { slot, email, setupTokenHash: sha256(code), setupTokenExpiresAt: new Date(Date.now() + 3600_000) },
    update: { email, setupTokenHash: sha256(code), setupTokenExpiresAt: new Date(Date.now() + 3600_000) },
  });
  return code;
}

export async function createUser(slot: number, email: string, displayName: string, password = "correct horse battery"): Promise<TestUser> {
  const setupCode = await invite(slot, email);
  const res = await api().post("/api/v1/auth/setup").send({ email, setupCode, password, displayName, deviceName: `${displayName} phone` });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, email, accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, sessionId: res.body.sessionId };
}

export async function createPair() {
  const a = await createUser(1, "ayaan@example.com", "Ayaan");
  const b = await createUser(2, "zara@example.com", "Zara");
  return { a, b };
}

export const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

export async function connect(u: TestUser): Promise<Socket> {
  const socket = ioClient(baseUrl, { auth: { token: u.accessToken }, transports: ["websocket"], reconnection: false, forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (e) => reject(e));
  });
  return socket;
}

export function emitAck<T = any>(socket: Socket, event: string, data: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

export function waitFor<T = any>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

let n = 0;
/** Fake but well-formed E2EE envelope (the server must treat it as opaque). */
export const envelope = () => ({
  ciphertext: Buffer.from(`ciphertext-${++n}-${"x".repeat(24)}`).toString("base64"),
  nonce: Buffer.from(`nonce-${n}-${"y".repeat(18)}`).toString("base64").slice(0, 32),
});
export const clientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function uploadFake(u: TestUser, kind: string, sizeBytes = 1000) {
  const res = await api().post("/api/v1/media/uploads").set(auth(u)).send({ kind, sizeBytes });
  if (res.status !== 201) throw new Error(`upload create failed ${res.status} ${JSON.stringify(res.body)}`);
  const key = new URL(res.body.uploadUrl).pathname.slice(1);
  objects.set(key, sizeBytes);
  const done = await api().post(`/api/v1/media/uploads/${res.body.attachmentId}/complete`).set(auth(u));
  if (done.status !== 200) throw new Error(`complete failed ${done.status}`);
  return res.body.attachmentId as string;
}
