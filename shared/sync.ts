import type { Task } from "./tasks";
// Keep multibyte Japanese notes below the API's 128 KiB request limit.
export function nextSyncBatch(tasks: Task[]): Task[] {
  const batch: Task[] = [];
  const encoder = new TextEncoder();
  for (const task of tasks.slice(0, 50)) {
    const candidate = [...batch, task];
    if (
      encoder.encode(JSON.stringify({ tasks: candidate })).byteLength > 120000
    )
      break;
    batch.push(task);
  }
  return batch;
}
