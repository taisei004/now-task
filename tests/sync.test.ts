import { expect, it } from "vitest";
import { nextSyncBatch } from "../shared/sync";
import { newTask } from "../shared/tasks";
it("長い日本語メモでもAPIの128 KiB上限を超えない", () => {
  const tasks = Array.from({ length: 50 }, () => newTask("あ".repeat(2000)));
  const batch = nextSyncBatch(tasks);
  expect(batch.length).toBeGreaterThan(0);
  expect(batch.length).toBeLessThan(50);
  expect(
    new TextEncoder().encode(JSON.stringify({ tasks: batch })).byteLength,
  ).toBeLessThanOrEqual(131072);
});
it("短いメモは最大50件ずつ送る", () => {
  expect(
    nextSyncBatch(Array.from({ length: 60 }, () => newTask("メモ"))),
  ).toHaveLength(50);
  expect(nextSyncBatch([])).toEqual([]);
});
