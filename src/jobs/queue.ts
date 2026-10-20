import { processJob } from "./processors.js";
import { logger } from "../lib/logger.js";

export const QUEUE_NAME = "amai-jobs";

const callTimeouts = new Map<string, NodeJS.Timeout>();

export async function scheduleCallTimeout(callId: string, delayMs: number) {
  if (callTimeouts.has(callId)) {
    clearTimeout(callTimeouts.get(callId));
  }
  const timer = setTimeout(async () => {
    callTimeouts.delete(callId);
    try {
      await processJob("call-timeout", { callId });
    } catch (err) {
      logger.error({ err, callId }, "call timeout job failed");
    }
  }, delayMs);
  callTimeouts.set(callId, timer);
}

export function cancelCallTimeout(callId: string) {
  const timer = callTimeouts.get(callId);
  if (timer) {
    clearTimeout(timer);
    callTimeouts.delete(callId);
  }
}

let intervals: NodeJS.Timeout[] = [];

/** Repeating maintenance jobs (idempotent: safe to call on every boot). */
export async function registerSchedulers() {
  for (const i of intervals) clearInterval(i);
  intervals = [];

  intervals.push(
    setInterval(() => processJob("expire-statuses", {}).catch((err) => logger.error({ err }, "expire-statuses failed")), 60_000),
    setInterval(() => processJob("cleanup-uploads", {}).catch((err) => logger.error({ err }, "cleanup-uploads failed")), 60 * 60_000),
    setInterval(() => processJob("cleanup-recordings", {}).catch((err) => logger.error({ err }, "cleanup-recordings failed")), 6 * 60 * 60_000),
    setInterval(() => processJob("cleanup-tokens", {}).catch((err) => logger.error({ err }, "cleanup-tokens failed")), 24 * 60 * 60_000),
  );

  processJob("expire-statuses", {}).catch(() => undefined);
}

export async function closeQueue() {
  for (const i of intervals) clearInterval(i);
  intervals = [];
  for (const t of callTimeouts.values()) clearTimeout(t);
  callTimeouts.clear();
}
