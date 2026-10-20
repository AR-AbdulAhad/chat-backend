/**
 * DEVELOPMENT ONLY. Creates two local test accounts with throwaway passwords.
 * Refuses to run when NODE_ENV=production. Production accounts are created
 * with `npm run provision`.
 */
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { hashPassword } from "../src/lib/tokens.js";
import { ensureConversation } from "../src/modules/users/service.js";

if (env.NODE_ENV === "production") {
  console.error("Refusing to seed development data in production.");
  process.exit(1);
}

const people = [
  { slot: 1, email: "abdulahad010274@gmail.com", displayName: "Ahad", password: "@Ahad12345" },
  { slot: 2, email: "amaidahussain2020@gmail.com", displayName: "Amaida", password: "@Amai12345" },
];

for (const p of people) {
  const account = await prisma.authorizedAccount.upsert({ where: { slot: p.slot }, create: { slot: p.slot, email: p.email }, update: {} });
  const exists = await prisma.user.findUnique({ where: { authorizedAccountId: account.id } });
  if (!exists) {
    await prisma.user.create({
      data: {
        authorizedAccountId: account.id,
        email: account.email,
        passwordHash: await hashPassword(p.password),
        displayName: p.displayName,
        settings: { create: {} },
        theme: { create: {} },
      },
    });
  }
  console.log(`dev account: ${account.email} / ${exists ? "(unchanged)" : p.password}`);
}
await ensureConversation();
await prisma.$disconnect();
