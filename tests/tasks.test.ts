import { TaskSchema } from "../worker/schema";
import { describe, it, expect } from "vitest";
import {
  dateKey,
  newTask,
  rankTasks,
  recommend,
  swipeStatus,
} from "../shared/tasks";
const now = +new Date(2026, 9, 19, 12),
  today = "2026-10-19";
describe("ラフな入力", () => {
  it("入力内容を保持する", () =>
    expect(newTask("  資料をまとめる  ", now).text).toBe("資料をまとめる"));
  it("今日の期限を読む", () =>
    expect(newTask("今日中に送信", now).due).toBe(today));
  it("明日の期限を読む", () =>
    expect(newTask("明日までに送信", now).due).toBe("2026-10-20"));
  it("明後日を明日と誤認しない", () =>
    expect(newTask("明後日まで", now).due).toBe("2026-10-21"));
  it("明示日付を読む", () =>
    expect(newTask("2026/11/2 提出", now).due).toBe("2026-11-02"));
  it("存在しない日付を期限にしない", () =>
    expect(newTask("2026/2/30 提出", now).due).toBeNull());
  it("重要指定を読む", () =>
    expect(newTask("重要：企画書", now).importance).toBe("high"));
  it("期限を勝手に設定しない", () =>
    expect(newTask("企画書", now).due).toBeNull());
  it("空文字を拒否する", () =>
    expect(TaskSchema.safeParse(newTask(" ", now)).success).toBe(false));
  it("不正日付を拒否する", () =>
    expect(
      TaskSchema.safeParse({ ...newTask("a"), due: "2026-02-30" }).success,
    ).toBe(false));
});
describe("次の一つ", () => {
  const older = newTask("古い仕事", now - 1000),
    urgent = { ...newTask("今日の仕事", now), due: today },
    overdue = { ...newTask("期限超過", now), due: "2026-10-18" };
  it("期限超過→今日→期限なし", () =>
    expect(rankTasks([older, urgent, overdue], today).map((t) => t.id)).toEqual(
      [overdue.id, urgent.id, older.id],
    ));
  it("保留と完了を除外", () =>
    expect(
      rankTasks(
        [{ ...urgent, status: "held" }, { ...overdue, status: "done" }, older],
        today,
      ),
    ).toEqual([older]));
  it("完了すると次を推薦", () =>
    expect(
      recommend([{ ...urgent, status: "done" }, older], today)?.taskId,
    ).toBe(older.id));
  it("期限のない重要タスクを優先", () =>
    expect(
      rankTasks([older, { ...urgent, due: null, importance: "high" }], today)[0]
        .id,
    ).toBe(urgent.id));
  it("古いタスクから選ぶ", () =>
    expect(recommend([newTask("新しい", now), older], today)?.taskId).toBe(
      older.id,
    ));
  it("理由を示す", () =>
    expect(recommend([urgent], today)?.reason).toContain("今日が期限"));
  it("AIではない提案を区別", () =>
    expect(recommend([urgent], today)?.source).toBe("rules"));
  it("空なら推薦なし", () => expect(recommend([], today)).toBeNull());
});
describe("フリック", () => {
  it("右は完了", () => expect(swipeStatus(100)).toBe("done"));
  it("左は保留", () => expect(swipeStatus(-100)).toBe("held"));
  it("小さな移動で変更しない", () => expect(swipeStatus(20, 700)).toBeNull());
  it("速い右フリック", () => expect(swipeStatus(40, 700)).toBe("done"));
  it("速い左フリック", () => expect(swipeStatus(-40, -700)).toBe("held"));
});
