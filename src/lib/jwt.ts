import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AccessClaims {
  sub: string; // user id
  sid: string; // device session id
}

export function signAccessToken(claims: AccessClaims) {
  return jwt.sign({ sid: claims.sid, typ: "access" }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: claims.sub,
    issuer: env.JWT_ISSUER,
    audience: "amai-app",
    expiresIn: env.ACCESS_TOKEN_TTL_SEC,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ["HS256"],
    issuer: env.JWT_ISSUER,
    audience: "amai-app",
  }) as jwt.JwtPayload;
  if (payload.typ !== "access" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw new Error("invalid token type");
  }
  return { sub: payload.sub, sid: payload.sid };
}
