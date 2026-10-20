// Standalone worker process: `npm run start:worker` (set RUN_WORKER_IN_PROCESS=false on the API).
import { startWorker, stopWorker } from "./runner.js";
import { logger } from "../lib/logger.js";

await startWorker();
logger.info("amai worker started");
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void stopWorker().then(() => process.exit(0));
  });
}
