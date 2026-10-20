import { registerSchedulers, closeQueue } from "./queue.js";

export async function startWorker() {
  await registerSchedulers();
  return { isRunning: true };
}

export async function stopWorker() {
  await closeQueue();
}
