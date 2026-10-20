import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { unauthorized } from "../lib/errors.js";

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Resolves an access token to a live (non-revoked, non-expired) session. */
export async function authenticateToken(token: string | undefined): Promise<AuthContext> {
  if (!token) throw unauthorized("missing_token");
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw unauthorized("invalid_token");
  }
  const session = await prisma.deviceSession.findUnique({
    where: { id: claims.sid },
    select: { userId: true, revokedAt: true, expiresAt: true },
  });
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthorized("session_revoked");
  }
  return { userId: claims.sub, sessionId: claims.sid };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  authenticateToken(token)
    .then((ctx) => {
      req.auth = ctx;
      next();
    })
    .catch(next);
}

export function authOf(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
