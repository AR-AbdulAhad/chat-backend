import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

/** OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1). */
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, ARGON2_OPTS);
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password).catch(() => false);
/** A real hash of a random secret so failed lookups take the same time as real ones. */
let dummyHash: Promise<string> | undefined;
export const dummyVerify = async (password: string) => {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummyHash, password);
  return false;
};

export const randomToken = (bytes = 48) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Human-friendly one-time setup code, e.g. "K7QF-2MXD-9PAR". */
export function setupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

export function safeEqualHex(a: string, b: string) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
