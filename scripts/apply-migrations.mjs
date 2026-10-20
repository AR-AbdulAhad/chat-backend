// Applies prisma/migrations/*/migration.sql in order and records them in
// _prisma_migrations exactly like `prisma migrate deploy` does, so both tools
// can be used interchangeably. Use `npm run migrate:deploy` on servers where the
// Prisma schema engine can be downloaded; this script is the fallback.
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

const dir = path.resolve(import.meta.dirname, "../prisma/migrations");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
const done = new Set((await client.query(
  `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).rows.map(r => r.migration_name));
const names = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
for (const name of names) {
  if (done.has(name)) continue;
  const sql = readFileSync(path.join(dir, name, "migration.sql"), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const id = randomUUID();
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO "_prisma_migrations"(id, checksum, migration_name) VALUES ($1,$2,$3)`, [id, checksum, name]);
    await client.query(sql);
    await client.query(`UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1`, [id]);
    await client.query("COMMIT");
    console.log(`applied ${name}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`failed ${name}:`, e.message);
    process.exitCode = 1;
    break;
  }
}
await client.end();
