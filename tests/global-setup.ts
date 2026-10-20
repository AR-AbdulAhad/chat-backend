import { execFileSync } from "node:child_process";
import pg from "pg";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://amai:amai_dev@127.0.0.1:5432/amai_test";
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, "/postgres") });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS amai_test WITH (FORCE)");
  await admin.query("CREATE DATABASE amai_test");
  await admin.end();
  execFileSync("node", ["scripts/apply-migrations.mjs"], { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
