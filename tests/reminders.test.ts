import { afterEach, expect, it, vi } from "vitest";
import { database } from "./helpers/database";
import { newTask } from "../shared/tasks";
import {
  reminderSlot,
  reminderMessage,
  sendScheduledReminders,
} from "../worker/discord-reminders";
import { encryptNotionToken } from "../worker/notion-client";
import { hash, type Env } from "../worker/auth";
import app from "../worker/index";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const time = Date.parse("2026-10-22T00:00:00Z");
it("日本時間の9・13・18時だけを選び日付を正しく扱う", () => {
  for (const hour of [0, 4, 9])
    expect(
      reminderSlot(
        Date.parse(`2026-10-22T${String(hour).padStart(2, "0")}:00:00Z`),
      ),
    ).not.toBeNull();
  expect(reminderSlot(time)).toBe("2026-10-22T09");
  expect(reminderSlot(time + 60000)).toBeNull();
  expect(reminderSlot(time + 3600000)).toBeNull();
});
it("完了・保留・要確認を除外し今日と期限超過を分ける", () => {
  const tasks = [
    newTask("今日", 1, "2026-10-22"),
    newTask("過去"),
    newTask("完了"),
    newTask("保留"),
    newTask("未確認"),
  ];
  tasks[1].due = "2026-10-21";
  tasks[2].status = "done";
  tasks[3].status = "held";
  tasks[4].needsReview = true;
  const m = reminderMessage(tasks, time);
  expect(m.content).toContain("今日やること（今日が期日） 1件");
  expect(m.content).toContain("期限超過 1件");
  expect(m.content).not.toContain("未確認");
  expect(m.content).not.toContain("保留");
  expect(m.allowed_mentions.parse).toEqual([]);
  expect(m.content.indexOf("過去")).toBeLessThan(
    m.content.indexOf("今日やること"),
  );
});
it("大量の長文タスクでもDiscordの2000文字内に収まる", () => {
  const tasks = Array.from({ length: 40 }, (_, i) => ({
    ...newTask("a".repeat(2000)),
    due: i % 2 ? "2026-10-22" : "2026-10-21",
    importance: "high" as const,
  }));
  expect(reminderMessage(tasks, time).content.length).toBeLessThanOrEqual(2000);
});
async function fixture() {
  const { db, binding } = database(),
    env = {
      DB: binding,
      NOTION_ENCRYPTION_KEY: btoa("k".repeat(32)),
      DISCORD_APPLICATION_ID: "123",
      DISCORD_GUILD_ID: "456",
      DISCORD_CHANNEL_ID: "789",
    } as Env;
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "alice",
    "alice@test",
    "Alice",
    time,
  );
  db.prepare("INSERT INTO discord_links VALUES(?,?,?)").run(
    "discord-alice",
    "alice",
    time,
  );
  db.prepare(
    "INSERT INTO discord_reminders(user_id,token_cipher) VALUES(?,?)",
  ).run(
    "alice",
    await encryptNotionToken(env, "alice", "fake-token-only-for-tests"),
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    await hash("session"),
    "alice",
    time + 86400000,
  );
  return { db, env };
}
it("同じ時刻のCronが重なっても一度だけ送信する", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  const { db, env } = await fixture(),
    mock = vi.fn().mockResolvedValue(new Response('{"id":"message"}'));
  vi.stubGlobal("fetch", mock);
  await Promise.all([
    sendScheduledReminders(env, time),
    sendScheduledReminders(env, time),
  ]);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0][1].redirect).toBe("manual");
  expect(JSON.parse(mock.mock.calls[0][1].body).enforce_nonce).toBe(true);
  expect(
    db.prepare("SELECT status FROM discord_reminder_deliveries").get()?.status,
  ).toBe("sent");
  db.close();
});
it("失敗時はエラーを記録し不明な送信結果を自動再送しない", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  const { db, env } = await fixture(),
    mock = vi
      .fn()
      .mockResolvedValue(new Response("private raw error", { status: 403 }));
  vi.stubGlobal("fetch", mock);
  await sendScheduledReminders(env, time);
  await sendScheduledReminders(env, time);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(
    db.prepare("SELECT last_error FROM discord_reminders").get()?.last_error,
  ).toContain("権限");
  db.close();
});
it("停止・未連携・古すぎるCronでは送信しない", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  const { db, env } = await fixture(),
    mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  db.prepare("UPDATE discord_reminders SET enabled=0").run();
  await sendScheduledReminders(env, time);
  db.prepare("UPDATE discord_reminders SET enabled=1").run();
  await sendScheduledReminders(env, time - 86400000);
  db.prepare("DELETE FROM discord_links").run();
  await sendScheduledReminders(env, time);
  expect(mock).not.toHaveBeenCalled();
  db.close();
});
it("認証・送信元の検証とトークン非表示を守り停止時にキーを削除する", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(time);
  const { db, env } = await fixture();
  expect(
    (await app.request("https://now.test/api/discord-reminders", {}, env))
      .status,
  ).toBe(401);
  const headers = {
    Cookie: "now_session=session",
    Origin: "https://now.test",
    "Content-Type": "application/json",
  };
  const status = await app.request(
    "https://now.test/api/discord-reminders",
    { headers },
    env,
  );
  expect(await status.text()).not.toContain("token");
  expect(
    (
      await app.request(
        "https://now.test/api/discord-reminders/stop",
        {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.test" },
          body: "{}",
        },
        env,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        "https://now.test/api/discord-reminders/stop",
        { method: "POST", headers, body: "{}" },
        env,
      )
    ).status,
  ).toBe(200);
  expect(db.prepare("SELECT * FROM discord_reminders").all()).toHaveLength(0);
  db.close();
});
