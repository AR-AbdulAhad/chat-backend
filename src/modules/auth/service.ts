import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { audit } from "../../lib/audit.js";
import { dummyVerify, hashPassword, randomToken, sha256, safeEqualHex, verifyPassword } from "../../lib/tokens.js";
import { signAccessToken } from "../../lib/jwt.js";
import { badRequest, unauthorized, HttpError } from "../../lib/errors.js";
import { disconnectSession } from "../../lib/realtime.js";
import { ensureConversation } from "../users/service.js";

export interface ClientInfo {
  ip?: string | null;
  userAgent?: string | null;
  deviceName: string;
}

const day = 24 * 60 * 60 * 1000;

async function issueTokens(userId: string, sessionId: string) {
  const refreshToken = randomToken(48);
  await prisma.refreshToken.create({
    data: {
      sessionId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * day),
    },
  });
  return {
    accessToken: signAccessToken({ sub: userId, sid: sessionId }),
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SEC,
    sessionId,
  };
}

/**
 * Amai keeps one active device per account. This keeps the end-to-end
 * encryption identity unambiguous and means a stolen device is cut off the
 * moment its owner signs in elsewhere.
 */
async function revokeOtherSessions(userId: string, keepSessionId: string | null, reason: string) {
  const sessions = await prisma.deviceSession.findMany({
    where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    select: { id: true },
  });
  if (sessions.length === 0) return;
  const ids = sessions.map((s) => s.id);
  await prisma.$transaction([
    prisma.deviceSession.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date(), revokeReason: reason } }),
    prisma.pushToken.deleteMany({ where: { sessionId: { in: ids } } }),
  ]);
  ids.forEach((id) => disconnectSession(id, reason));
}

async function createSession(userId: string, client: ClientInfo) {
  const session = await prisma.deviceSession.create({
    data: {
      userId,
      deviceName: client.deviceName.slice(0, 120),
      ip: client.ip ?? null,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * day),
    },
  });
  await revokeOtherSessions(userId, session.id, "new_login");
  return session;
}

/**
 * Redeems a one-time setup code issued by `npm run provision`.
 * First use creates the account; a code issued with --reset-password resets it.
 */
export async function setupAccount(input: { email: string; setupCode: string; password: string; displayName: string }, client: ClientInfo) {
  const account = await prisma.authorizedAccount.findUnique({ where: { email: input.email }, include: { user: true } });
  const codeHash = sha256(input.setupCode.trim().toUpperCase());
  if (
    !account ||
    !account.setupTokenHash ||
    !account.setupTokenExpiresAt ||
    account.setupTokenExpiresAt < new Date() ||
    !safeEqualHex(account.setupTokenHash, codeHash)
  ) {
    await audit("login_unauthorized_email", { ip: client.ip, userAgent: client.userAgent, meta: { flow: "setup" } });
    throw unauthorized("invalid_setup", "Invitation code is invalid or expired");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    // Consume the one-time code first so a race cannot use it twice.
    const consumed = await tx.authorizedAccount.updateMany({
      where: { id: account.id, setupTokenHash: account.setupTokenHash },
      data: { setupTokenHash: null, setupTokenExpiresAt: null },
    });
    if (consumed.count !== 1) throw unauthorized("invalid_setup");
    if (account.user) {
      return tx.user.update({ where: { id: account.user.id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
    }
    return tx.user.create({
      data: {
        authorizedAccountId: account.id,
        email: account.email,
        passwordHash,
        displayName: input.displayName,
        settings: { create: {} },
        theme: { create: {} },
      },
    });
  });
  await ensureConversation();
  await audit(account.user ? "password_changed" : "account_setup", { userId: user.id, ip: client.ip, userAgent: client.userAgent, meta: { via: "setup_code" } });
  const session = await createSession(user.id, client);
  return { user, tokens: await issueTokens(user.id, session.id) };
}

export async function login(input: { email: string; password: string }, client: ClientInfo) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    // Same work, same response for unknown, unauthorized and wrong passwords.
    await dummyVerify(input.password);
    await audit("login_unauthorized_email", { ip: client.ip, userAgent: client.userAgent });
    throw unauthorized("invalid_credentials", "Email or password is incorrect");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit("login_locked", { userId: user.id, ip: client.ip });
    throw new HttpError(423, "account_locked", "Too many attempts. Try again later.");
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    const lock = failures >= env.LOGIN_MAX_FAILURES;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : failures,
        lockedUntil: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : null,
      },
    });
    await audit("login_failed", { userId: user.id, ip: client.ip, meta: { failures } });
    throw unauthorized("invalid_credentials", "Email or password is incorrect");
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  const session = await createSession(user.id, client);
  await audit("login_success", { userId: user.id, ip: client.ip, userAgent: client.userAgent, meta: { sessionId: session.id } });
  return { user, tokens: await issueTokens(user.id, session.id) };
}

export async function refresh(refreshToken: string, client: { ip?: string | null }) {
  const tokenHash = sha256(refreshToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { session: true } });
  if (!record) throw unauthorized("invalid_refresh");

  if (record.usedAt) {
    // Reuse of a rotated token => likely theft. Kill the whole session.
    await prisma.deviceSession.update({ where: { id: record.sessionId }, data: { revokedAt: new Date(), revokeReason: "refresh_reuse" } });
    await prisma.pushToken.deleteMany({ where: { sessionId: record.sessionId } });
    disconnectSession(record.sessionId, "refresh_reuse");
    await audit("refresh_reuse_detected", { userId: record.session.userId, ip: client.ip, meta: { sessionId: record.sessionId } });
    throw unauthorized("refresh_reuse");
  }
  if (record.expiresAt < new Date() || record.session.revokedAt || record.session.expiresAt < new Date()) {
    throw unauthorized("session_expired");
  }

  // Atomically mark used; a concurrent duplicate request loses here.
  const marked = await prisma.refreshToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
  if (marked.count !== 1) throw unauthorized("refresh_reuse");

  // Sliding session expiry.
  await prisma.deviceSession.update({
    where: { id: record.sessionId },
    data: { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * day), ip: client.ip ?? undefined },
  });
  return issueTokens(record.session.userId, record.sessionId);
}

export async function logout(userId: string, sessionId: string, ip?: string | null) {
  await prisma.deviceSession.updateMany({ where: { id: sessionId, userId }, data: { revokedAt: new Date(), revokeReason: "logout" } });
  await prisma.pushToken.deleteMany({ where: { sessionId } });
  await audit("logout", { userId, ip });
  disconnectSession(sessionId, "logout");
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, current))) throw badRequest("wrong_password", "Current password is incorrect");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } });
  await revokeOtherSessions(userId, sessionId, "password_changed");
  await audit("password_changed", { userId });
}
