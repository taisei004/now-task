import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDB } from "idb";
import { newTask } from "../shared/tasks";
import {
  dirtyTasks,
  markClean,
  mergeRemote,
  readTasks,
  writeTask,
  emptyCapture,
  getCaptureOptions,
  saveCaptureOptions,
} from "../src/storage";
beforeEach(async () => {
  const db = await openDB("now-task", 1);
  await db.clear("tasks");
  await db.clear("meta");
  db.close();
});
describe("端末とサーバーの同期", () => {
  it("未送信メモの追加情報はアカウントごとに保存する", async () => {
    const options = {
      due: "2026-10-25",
      importance: "high" as const,
      tags: [{ name: "仕事", color: "blue" as const }],
    };
    await saveCaptureOptions("user:a", options);
    expect(await getCaptureOptions("user:a")).toEqual(options);
    expect(await getCaptureOptions("user:b")).toEqual(emptyCapture());
    expect(await getCaptureOptions("guest")).toEqual(emptyCapture());
  });
  it("完全なサーバー応答で削除を反映し、未同期・他ユーザー・ゲストは保持する", async () => {
    const removed = newTask("削除済み"),
      pending = newTask("未同期"),
      other = newTask("別ユーザー"),
      guest = newTask("ゲスト");
    await writeTask("user:a", removed, false);
    await writeTask("user:a", pending, true);
    await writeTask("user:b", other, false);
    await writeTask("guest", guest, false);
    await mergeRemote("user:a", [], true);
    expect((await readTasks("user:a")).map((t) => t.id)).toEqual([pending.id]);
    expect(await readTasks("user:b")).toEqual([other]);
    expect(await readTasks("guest")).toEqual([guest]);
  });
  it("上限による部分応答ではキャッシュを削除しない", async () => {
    const existing = newTask("既存");
    await writeTask("user:a", existing, false);
    await mergeRemote("user:a", [], false);
    expect(await readTasks("user:a")).toEqual([existing]);
  });
  it("同期中に編集したタスクを古いサーバー応答で上書きしない", async () => {
    const old = newTask("古い内容"),
      edited = { ...old, text: "新しい内容", updatedAt: old.updatedAt + 1 };
    await writeTask("user:a", edited, true);
    await mergeRemote("user:a", [old], true);
    expect(await readTasks("user:a")).toEqual([edited]);
  });
  it("古い送信の完了で新しい編集を同期済みにしない", async () => {
    const old = newTask("古い内容"),
      edited = { ...old, text: "新しい内容", updatedAt: old.updatedAt + 1 };
    await writeTask("user:a", edited, true);
    await markClean("user:a", [old]);
    expect(await dirtyTasks("user:a")).toEqual([edited]);
    await markClean("user:a", [edited]);
    expect(await dirtyTasks("user:a")).toEqual([]);
  });
  it("同期済みのタスクを新しいサーバー応答で更新する", async () => {
    const old = newTask("未完了"),
      updated = { ...old, status: "done" as const };
    await writeTask("user:a", old, false);
    await mergeRemote("user:a", [updated], true);
    expect(await readTasks("user:a")).toEqual([updated]);
  });
});
