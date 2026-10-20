/**
 * Amai account provisioning — the ONLY way accounts come into existence.
 *
 *   npm run provision -- --slot 1 --email you@example.com
 *   npm run provision -- --slot 2 --email partner@example.com
 *   npm run provision -- --slot 1 --reset-password      # new one-time code for an existing account
 *   npm run provision -- --list
 *
 * Prints a one-time setup code (valid SETUP_TOKEN_TTL_HOURS). Only its SHA-256
 * hash is stored. Deliver the code to the person out of band (in person, Signal...).
 * The database CHECK constraint makes a third slot impossible.
 */
import { parseArgs } from "node:util";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { setupCode, sha256 } from "../src/lib/tokens.js";
import { audit } from "../src/lib/audit.js";

const { values } = parseArgs({
  options: {
    slot: { type: "string" },
    email: { type: "string" },
    "reset-password": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

async function main() {
  if (values.list) {
    const rows = await prisma.authorizedAccount.findMany({ orderBy: { slot: "asc" }, include: { user: { select: { displayName: true, createdAt: true } } } });
    for (const r of rows) {
      console.log(`slot ${r.slot}: ${r.email} — ${r.user ? `active (${r.user.displayName}, since ${r.user.createdAt.toISOString()})` : r.setupTokenExpiresAt ? `invited, code expires ${r.setupTokenExpiresAt.toISOString()}` : "invited, code expired"}`);
    }
    if (rows.length === 0) console.log("No accounts provisioned yet.");
    return;
  }

  const slot = Number(values.slot);
  if (slot !== 1 && slot !== 2) throw new Error("--slot must be 1 or 2 (Amai supports exactly two accounts)");

  const existing = await prisma.authorizedAccount.findUnique({ where: { slot }, include: { user: true } });
  const code = setupCode();
  const expires = new Date(Date.now() + env.SETUP_TOKEN_TTL_HOURS * 3600_000);

  if (values["reset-password"]) {
    if (!existing?.user) throw new Error(`Slot ${slot} has no active account to reset`);
    await prisma.authorizedAccount.update({ where: { id: existing.id }, data: { setupTokenHash: sha256(code), setupTokenExpiresAt: expires } });
    await audit("provisioning", { userId: existing.user.id, meta: { action: "reset_password_code", slot } });
  } else {
    const email = values.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email is required and must be valid");
    if (existing?.user && existing.email !== email) throw new Error(`Slot ${slot} is already in use by an active account (${existing.email})`);
    const other = await prisma.authorizedAccount.findUnique({ where: { email } });
    if (other && other.slot !== slot) throw new Error(`${email} is already provisioned in slot ${other.slot}`);
    await prisma.authorizedAccount.upsert({
      where: { slot },
      create: { slot, email, setupTokenHash: sha256(code), setupTokenExpiresAt: expires },
      update: { email, setupTokenHash: sha256(code), setupTokenExpiresAt: expires },
    });
    await audit("provisioning", { meta: { action: existing ? "reissue_invite" : "invite", slot } });
  }

  console.log("");
  console.log(`  Account slot ${slot} ready.`);
  console.log(`  One-time setup code: ${code}`);
  console.log(`  Expires: ${expires.toISOString()}`);
  console.log("");
  console.log("  In the app: Sign in → \"Have an invitation code?\" → enter email + code + new password.");
  console.log("  This code is shown once and is not stored in readable form.");
}

main()
  .catch((e) => {
    console.error(`provision failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
