import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, connect, createPair, createUser, invite, resetDb, startTestServer, stopTestServer, waitFor } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

beforeAll(startTestServer);
afterAll(stopTestServer);
beforeEach(resetDb);

describe("two-account restriction", () => {
  it("has no registration endpoint", async () => {
    for (const path of ["/api/v1/auth/register", "/api/v1/auth/signup", "/api/v1/users"]) {
      const res = await api().post(path).send({ email: "x@example.com", password: "whatever-123" });
      expect([401, 404]).toContain(res.status);
    }
  });

  it("database refuses a third authorized account", async () => {
    await invite(1, "a@example.com");
    await invite(2, "b@example.com");
    await expect(prisma.authorizedAccount.create({ data: { slot: 3, email: "c@example.com" } })).rejects.toThrow();
    await expect(prisma.authorizedAccount.create({ data: { slot: 1, email: "d@example.com" } })).rejects.toThrow();
    expect(await prisma.authorizedAccount.count()).toBe(2);
  });

  it("database refuses a user whose email is not allowlisted", async () => {
    await invite(1, "a@example.com");
    const acc = await prisma.authorizedAccount.findFirstOrThrow();
    await expect(
      prisma.user.create({ data: { authorizedAccountId: acc.id, email: "intruder@example.com", passwordHash: "x", displayName: "x" } }),
    ).rejects.toThrow();
  });

  it("rejects login for an unknown (third) email with a generic error", async () => {
    await createPair();
    const res = await api().post("/api/v1/auth/login").send({ email: "third@example.com", password: "correct horse battery" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_credentials");
    expect(await prisma.auditEvent.count({ where: { type: "login_unauthorized_email" } })).toBe(1);
  });

  it("setup requires the right one-time code, and the code works only once", async () => {
    const code = await invite(1, "a@example.com");
    const bad = await api().post("/api/v1/auth/setup").send({ email: "a@example.com", setupCode: "AAAA-BBBB-CCCC", password: "long enough pw", displayName: "A" });
    expect(bad.status).toBe(401);
    const good = await api().post("/api/v1/auth/setup").send({ email: "a@example.com", setupCode: code, password: "long enough pw", displayName: "A" });
    expect(good.status).toBe(201);
    const again = await api().post("/api/v1/auth/setup").send({ email: "a@example.com", setupCode: code, password: "another pw 123", displayName: "A" });
    expect(again.status).toBe(401);
  });

  it("setup with an email that was never invited fails", async () => {
    const code = await invite(1, "a@example.com");
    const res = await api().post("/api/v1/auth/setup").send({ email: "b@example.com", setupCode: code, password: "long enough pw", displayName: "B" });
    expect(res.status).toBe(401);
  });

  it("enforces password length", async () => {
    const code = await invite(1, "a@example.com");
    const res = await api().post("/api/v1/auth/setup").send({ email: "a@example.com", setupCode: code, password: "short", displayName: "A" });
    expect(res.status).toBe(400);
  });

  it("stores passwords as argon2id", async () => {
    const { a } = await createPair();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
  });
});

describe("login, sessions and refresh rotation", () => {
  it("logs in and reaches protected routes", async () => {
    await createPair();
    const res = await api().post("/api/v1/auth/login").send({ email: "AYAAN@example.com", password: "correct horse battery" });
    expect(res.status).toBe(200);
    const me = await api().get("/api/v1/users/me").set({ Authorization: `Bearer ${res.body.accessToken}` });
    expect(me.status).toBe(200);
    expect(me.body.displayName).toBe("Ayaan");
  });

  it("rejects requests without or with a forged token", async () => {
    expect((await api().get("/api/v1/users/me")).status).toBe(401);
    expect((await api().get("/api/v1/users/me").set({ Authorization: "Bearer abc.def.ghi" })).status).toBe(401);
  });

  it("locks the account after repeated failures", async () => {
    await createPair();
    for (let i = 0; i < 5; i++) {
      await api().post("/api/v1/auth/login").send({ email: "ayaan@example.com", password: "wrong password!" });
    }
    const res = await api().post("/api/v1/auth/login").send({ email: "ayaan@example.com", password: "correct horse battery" });
    expect(res.status).toBe(423);
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const { a } = await createPair();
    const r1 = await api().post("/api/v1/auth/refresh").send({ refreshToken: a.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(a.refreshToken);
    // Re-using the old token revokes the whole session.
    const reuse = await api().post("/api/v1/auth/refresh").send({ refreshToken: a.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("refresh_reuse");
    const r2 = await api().post("/api/v1/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
    const me = await api().get("/api/v1/users/me").set({ Authorization: `Bearer ${r1.body.accessToken}` });
    expect(me.status).toBe(401);
  });

  it("logout revokes the session and disconnects its sockets", async () => {
    const { a } = await createPair();
    const socket = await connect(a);
    const revoked = waitFor(socket, "session:revoked");
    expect((await api().post("/api/v1/auth/logout").set(auth(a))).status).toBe(204);
    expect((await revoked).reason).toBe("logout");
    expect((await api().get("/api/v1/users/me").set(auth(a))).status).toBe(401);
    expect((await api().post("/api/v1/auth/refresh").send({ refreshToken: a.refreshToken })).status).toBe(401);
    socket.close();
  });

  it("a new login signs out the previous device", async () => {
    const { a } = await createPair();
    const res = await api().post("/api/v1/auth/login").send({ email: "ayaan@example.com", password: "correct horse battery", deviceName: "new phone" });
    expect(res.status).toBe(200);
    expect((await api().get("/api/v1/users/me").set(auth(a))).status).toBe(401);
  });

  it("socket connections require a valid token", async () => {
    await createPair();
    await expect(connect({ id: "", email: "", accessToken: "bad", refreshToken: "", sessionId: "" })).rejects.toThrow();
  });

  it("password reset code (--reset-password) resets the password", async () => {
    await createUser(1, "a@example.com", "A");
    const code = await invite(1, "a@example.com");
    const res = await api().post("/api/v1/auth/setup").send({ email: "a@example.com", setupCode: code, password: "brand new password", displayName: "ignored" });
    expect(res.status).toBe(201);
    const login = await api().post("/api/v1/auth/login").send({ email: "a@example.com", password: "brand new password" });
    expect(login.status).toBe(200);
    expect(login.body.user.displayName).toBe("A");
  });
});
