import { createServer } from "node:http";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { createSocketServer } from "./sockets/index.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { startWorker, stopWorker } from "./jobs/runner.js";

const app = createApp();
const http = createServer(app);
const io = createSocketServer(http);

if (env.RUN_WORKER_IN_PROCESS) await startWorker();

http.listen(env.PORT, env.HOST, () => logger.info(`amai api listening on ${env.HOST}:${env.PORT}`));

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  io.close();
  http.close();
  await stopWorker();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
