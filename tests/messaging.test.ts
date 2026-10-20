import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, clientId, connect, createPair, emitAck, envelope, pushes, resetDb, startTestServer, stopTestServer, waitFor } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDb);

async function registerPush(u: { accessToken: string }, token: string) {
  await api().put("/api/v1/devices/push-token").set({ Authorization: `Bearer ${u.accessToken}` }).send({ token });
}

describe("real-time messaging", () => {
  it("delivers a message to the partner over the socket and acks the sender", async () => {
    const { a, b } = await createPair();
    const sa = await connect(a);
    const sb = await connect(b);
    const incoming = waitFor(sb, "message:new");
    const ack = await emitAck(sa, "message:send", { clientId: clientId(), type: "text", ...envelope() });
    expect(ack.ok).toBe(true);
    const msg = await incoming;
    expect(msg.id).toBe(ack.data.id);
    expect(msg.senderId).toBe(a.id);
    expect(msg.ciphertext).toBe(ack.data.ciphertext);
    sa.close();
    sb.close();
  });

  it("stores only ciphertext — the server never sees plaintext", async () => {
    const { a } = await createPair();
    const env = envelope();
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...env });
    const row = await prisma.message.findFirstOrThrow();
    expect(row.ciphertext).toBe(env.ciphertext);
    const columns = Object.keys(row);
    expect(columns).not.toContain("text");
    expect(columns).not.toContain("body");
  });

  it("is idempotent per clientId (duplicate prevention on retry)", async () => {
    const { a } = await createPair();
    const body = { clientId: clientId(), type: "text", ...envelope() };
    const first = await api().post("/api/v1/messages").set(auth(a)).send(body);
    const second = await api().post("/api/v1/messages").set(auth(a)).send(body);
    const third = await api().post("/api/v1/messages").set(auth(a)).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(third.body.id).toBe(first.body.id);
    expect(await prisma.message.count()).toBe(1);
  });

  it("handles concurrent duplicate sends without creating two rows", async () => {
    const { a } = await createPair();
    const body = { clientId: clientId(), type: "text", ...envelope() };
    const results = await Promise.all(Array.from({ length: 5 }, () => api().post("/api/v1/messages").set(auth(a)).send(body)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.message.count()).toBe(1);
  });

  it("tracks delivered and read receipts", async () => {
    const { a, b } = await createPair();
    const sa = await connect(a);
    const sb = await connect(b);
    const sent = (await emitAck(sa, "message:send", { clientId: clientId(), type: "text", ...envelope() })).data;
    expect(sent.deliveredAt).toBeNull();

    const delivered = waitFor(sa, "receipt:update");
    await emitAck(sb, "message:receipts", { messageIds: [sent.id], kind: "delivered" });
    expect((await delivered).messageIds).toEqual([sent.id]);

    const read = waitFor(sa, "receipt:update");
    await emitAck(sb, "message:read-all", {});
    const r = await read;
    expect(r.readAt).not.toBeNull();

    const list = await api().get("/api/v1/messages").set(auth(a));
    expect(list.body.messages[0].readAt).not.toBeNull();
    sa.close();
    sb.close();
  });

  it("cannot mark your own messages as read", async () => {
    const { a } = await createPair();
    const sent = await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    const res = await api().post("/api/v1/messages/receipts").set(auth(a)).send({ messageIds: [sent.body.id], kind: "read" });
    expect(res.body.updated).toBe(0);
  });

  it("hides read receipts from the sender when either side disables them", async () => {
    const { a, b } = await createPair();
    await api().patch("/api/v1/settings").set(auth(b)).send({ readReceipts: false });
    const sent = await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    await api().post("/api/v1/messages/read-all").set(auth(b));
    const forSender = await api().get("/api/v1/messages").set(auth(a));
    expect(forSender.body.messages[0].id).toBe(sent.body.id);
    expect(forSender.body.messages[0].readAt).toBeNull();
    expect(forSender.body.messages[0].deliveredAt).not.toBeNull();
    const forReader = await api().get("/api/v1/messages").set(auth(b));
    expect(forReader.body.messages[0].readAt).not.toBeNull();
  });

  it("relays typing indicators to the partner only", async () => {
    const { a, b } = await createPair();
    const sa = await connect(a);
    const sb = await connect(b);
    const typing = waitFor(sb, "typing");
    await emitAck(sa, "typing", { active: true });
    expect(await typing).toEqual({ userId: a.id, active: true });
    sa.close();
    sb.close();
  });

  it("supports replies, reactions, pins, edits and delete-for-everyone with a tombstone", async () => {
    const { a, b } = await createPair();
    const original = (await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() })).body;
    const reply = await api().post("/api/v1/messages").set(auth(b)).send({ clientId: clientId(), type: "text", replyToId: original.id, ...envelope() });
    expect(reply.body.replyToId).toBe(original.id);

    expect((await api().put(`/api/v1/messages/${original.id}/reaction`).set(auth(b)).send({ emoji: "❤️" })).status).toBe(204);
    expect((await api().put(`/api/v1/messages/${original.id}/pin`).set(auth(b)).send({ pinned: true })).status).toBe(204);
    const pinned = await api().get("/api/v1/messages?pinned=true").set(auth(a));
    expect(pinned.body.messages.map((m: any) => m.id)).toEqual([original.id]);
    expect(pinned.body.messages[0].reactions[0].emoji).toBe("❤️");

    // Only the sender may edit.
    const edit = envelope();
    expect((await api().patch(`/api/v1/messages/${original.id}`).set(auth(b)).send(edit)).status).toBe(403);
    const edited = await api().patch(`/api/v1/messages/${original.id}`).set(auth(a)).send(edit);
    expect(edited.body.editedAt).not.toBeNull();
    expect(edited.body.ciphertext).toBe(edit.ciphertext);

    // Only the sender may delete for everyone; a tombstone stays visible.
    expect((await api().delete(`/api/v1/messages/${original.id}`).set(auth(b))).status).toBe(403);
    expect((await api().delete(`/api/v1/messages/${original.id}`).set(auth(a))).status).toBe(204);
    const list = await api().get("/api/v1/messages").set(auth(b));
    const tomb = list.body.messages.find((m: any) => m.id === original.id);
    expect(tomb).toBeDefined();
    expect(tomb.deletedAt).not.toBeNull();
    expect(tomb.ciphertext).toBeNull();
    expect(tomb.reactions).toEqual([]);
    expect(tomb.pinnedAt).toBeNull();
  });

  it("refuses edits after the edit window", async () => {
    const { a } = await createPair();
    const m = (await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() })).body;
    await prisma.message.update({ where: { id: m.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    const res = await api().patch(`/api/v1/messages/${m.id}`).set(auth(a)).send(envelope());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("edit_window_passed");
  });

  it("paginates older messages", async () => {
    const { a } = await createPair();
    for (let i = 0; i < 7; i++) {
      await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    }
    const page1 = await api().get("/api/v1/messages?limit=5").set(auth(a));
    expect(page1.body.messages).toHaveLength(5);
    expect(page1.body.hasMore).toBe(true);
    const oldest = page1.body.messages[4].createdAt;
    const page2 = await api().get(`/api/v1/messages?limit=5&before=${encodeURIComponent(oldest)}`).set(auth(a));
    expect(page2.body.messages).toHaveLength(2);
    expect(page2.body.hasMore).toBe(false);
  });

  it("filters messages by date range", async () => {
    const { a } = await createPair();
    const old = (await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() })).body;
    await prisma.message.update({ where: { id: old.id }, data: { createdAt: new Date("2026-01-05T10:00:00Z") } });
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    const res = await api().get("/api/v1/messages?after=2026-01-05T00:00:00Z&before=2026-01-06T00:00:00Z").set(auth(a));
    expect(res.body.messages.map((m: any) => m.id)).toEqual([old.id]);
  });

  it("synchronizes everything changed since the last sync point (offline catch-up)", async () => {
    const { a, b } = await createPair();
    const first = await api().get("/api/v1/messages/sync?since=0").set(auth(b));
    const since = first.body.nextSince;
    // b is "offline" while a sends, edits and reacts.
    const m1 = (await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() })).body;
    const m2 = (await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() })).body;
    await api().patch(`/api/v1/messages/${m1.id}`).set(auth(a)).send(envelope());
    const sync = await api().get(`/api/v1/messages/sync?since=${since}`).set(auth(b));
    const ids = sync.body.messages.map((m: any) => m.id);
    expect(ids).toEqual([m2.id, m1.id]); // m1 changed last, so it comes last
    expect(sync.body.messages[1].editedAt).not.toBeNull();
    const again = await api().get(`/api/v1/messages/sync?since=${sync.body.nextSince}`).set(auth(b));
    expect(again.body.messages).toHaveLength(0);
  });

  it("reports unread counts on the conversation", async () => {
    const { a, b } = await createPair();
    for (let i = 0; i < 3; i++) await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    const conv = await api().get("/api/v1/conversation").set(auth(b));
    expect(conv.body.unreadCount).toBe(3);
    expect(conv.body.partnerId).toBe(a.id);
    await api().post("/api/v1/messages/read-all").set(auth(b));
    expect((await api().get("/api/v1/conversation").set(auth(b))).body.unreadCount).toBe(0);
  });

  it("sends a data-only push with ciphertext when the partner is offline", async () => {
    const { a, b } = await createPair();
    await registerPush(b, "fcm-token-for-zara-device-123456");
    const env = envelope();
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...env });
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].token).toBe("fcm-token-for-zara-device-123456");
    expect(pushes[0].payload.data.type).toBe("message");
    expect(pushes[0].payload.data.ciphertext).toBe(env.ciphertext);
    expect(pushes[0].payload.priority).toBe("high");
  });

  it("skips push while the partner has the app open in the foreground", async () => {
    const { a, b } = await createPair();
    await registerPush(b, "fcm-token-for-zara-device-123456");
    const sb = await connect(b);
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toHaveLength(0);
    await emitAck(sb, "presence:state", { active: false });
    await api().post("/api/v1/messages").set(auth(a)).send({ clientId: clientId(), type: "text", ...envelope() });
    await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toHaveLength(1);
    sb.close();
  });

  it("rejects malformed payloads and invalid reply targets", async () => {
    const { a } = await createPair();
    const bad = await api().post("/api/v1/messages").set(auth(a)).send({ clientId: "x", type: "text", ciphertext: "<script>", nonce: "1" });
    expect(bad.status).toBe(400);
    const badReply = await api()
      .post("/api/v1/messages")
      .set(auth(a))
      .send({ clientId: clientId(), type: "text", replyToId: "00000000-0000-4000-8000-000000000000", ...envelope() });
    expect(badReply.status).toBe(400);
  });

  it("broadcasts presence and respects reciprocal last-seen privacy", async () => {
    const { a, b } = await createPair();
    const sb = await connect(b);
    const online = waitFor(sb, "presence:update");
    const sa = await connect(a);
    expect((await online).online).toBe(true);
    const offline = waitFor(sb, "presence:update");
    sa.close();
    const p = await offline;
    expect(p.online).toBe(false);
    expect(p.lastSeenAt).not.toBeNull();

    await api().patch("/api/v1/settings").set(auth(b)).send({ showLastSeen: false });
    const partner = await api().get("/api/v1/users/partner").set(auth(b));
    expect(partner.body.lastSeenAt).toBeNull();
    const reverse = await api().get("/api/v1/users/partner").set(auth(a));
    expect(reverse.body.lastSeenAt).toBeNull();
    sb.close();
  });

  it("syncs profile updates to both users in real time", async () => {
    const { a, b } = await createPair();
    const sb = await connect(b);
    const update = waitFor(sb, "profile:updated");
    await api().patch("/api/v1/users/me").set(auth(a)).send({ about: "Busy, text me" });
    const p = await update;
    expect(p.id).toBe(a.id);
    expect(p.about).toBe("Busy, text me");
    sb.close();
  });

  it("validates profile photos by content, not by declared type", async () => {
    const { a } = await createPair();
    const fake = await api().put("/api/v1/users/me/avatar").set(auth(a)).set("Content-Type", "image/png").send(Buffer.from("<?php echo 1; ?>"));
    expect(fake.status).toBe(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const ok = await api().put("/api/v1/users/me/avatar").set(auth(a)).set("Content-Type", "application/octet-stream").send(png);
    expect(ok.status).toBe(200);
    expect(ok.body.hasAvatar).toBe(true);
  });

  it("publishes identity keys and notifies the partner on key change", async () => {
    const { a, b } = await createPair();
    const sb = await connect(b);
    const pk1 = Buffer.alloc(32, 1).toString("base64");
    await api().put("/api/v1/keys/identity").set(auth(a)).send({ publicKey: pk1 });
    expect((await api().get("/api/v1/keys/partner").set(auth(b))).body.publicKey).toBe(pk1);
    const changed = waitFor(sb, "keys:changed");
    const pk2 = Buffer.alloc(32, 2).toString("base64");
    await api().put("/api/v1/keys/identity").set(auth(a)).send({ publicKey: pk2 });
    expect((await changed).publicKey).toBe(pk2);
    const history = await api().get("/api/v1/keys/history").set(auth(b));
    expect(history.body.keys).toHaveLength(2);
    expect(await prisma.identityKey.count({ where: { userId: a.id, revokedAt: null } })).toBe(1);
    sb.close();
  });
});
