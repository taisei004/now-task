import { openDB } from "idb";
import type { Task, Tag } from "../shared/tasks";
export type CaptureOptions = {
  source?: Task["source"];
  due: string;
  importance: "auto" | "normal" | "high";
  tags: Tag[];
};
export const emptyCapture = (): CaptureOptions => ({
  due: "",
  importance: "auto",
  tags: [],
});
export async function getCaptureOptions(
  scope: string,
): Promise<CaptureOptions> {
  return (await (await db).get("meta", `capture:${scope}`)) ?? emptyCapture();
}
export async function saveCaptureOptions(scope: string, value: CaptureOptions) {
  await (await db).put("meta", value, `capture:${scope}`);
}
const db = openDB("now-task", 1, {
  upgrade(db) {
    db.createObjectStore("tasks", { keyPath: "key" });
    db.createObjectStore("meta");
  },
});
export async function readTasks(scope: string): Promise<Task[]> {
  return (await (await db).getAll("tasks"))
    .filter((r) => r.scope === scope)
    .map((r) => r.task);
}
export async function writeTask(scope: string, task: Task, dirty = true) {
  await (
    await db
  ).put("tasks", { key: `${scope}:${task.id}`, scope, task, dirty });
}
export async function dirtyTasks(scope: string): Promise<Task[]> {
  return (await (await db).getAll("tasks"))
    .filter((r) => r.scope === scope && r.dirty)
    .map((r) => r.task);
}
export async function markClean(scope: string, sent: Task[]) {
  const database = await db;
  const tx = database.transaction("tasks", "readwrite");
  for (const task of sent) {
    const key = `${scope}:${task.id}`,
      row = await tx.store.get(key);
    if (row && row.task.updatedAt === task.updatedAt)
      await tx.store.put({ ...row, dirty: false });
  }
  await tx.done;
}
export async function mergeRemote(
  scope: string,
  tasks: Task[],
  complete = false,
) {
  const database = await db;
  const tx = database.transaction("tasks", "readwrite");
  for (const task of tasks) {
    const key = `${scope}:${task.id}`,
      row = await tx.store.get(key);
    if (!row?.dirty) await tx.store.put({ key, scope, task, dirty: false });
  }
  if (complete) {
    const remoteIds = new Set(tasks.map((task) => task.id));
    for (const row of await tx.store.getAll()) {
      if (row.scope === scope && !row.dirty && !remoteIds.has(row.task.id)) {
        await tx.store.delete(row.key);
      }
    }
  }
  await tx.done;
}
export async function getDraft(scope: string): Promise<string> {
  return (await (await db).get("meta", `draft:${scope}`)) ?? "";
}
export async function saveDraft(scope: string, text: string) {
  await (await db).put("meta", text, `draft:${scope}`);
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = (await response
      .json()
      .catch(() => ({ error: "接続できませんでした。" }))) as { error: string };
    throw Error(error.error);
  }
  return response.json();
}
