import { Hono } from "hono";
import { z } from "zod";
import { rankTasks, recommend, type Task } from "../shared/tasks";
import { hash, type Env, type User } from "./auth";
import { encryptNotionToken, decryptNotionToken } from "./notion-client";

export function reminderSlot(time: number) {
  const date = new Date(time + 9 * 3600000);
  if (date.getUTCMinutes() !== 0 || ![9, 13, 18].includes(date.getUTCHours()))
    return null;
  return date.toISOString().slice(0, 13);
}
const safe = (text: string) =>
  text
    .replace(/[\\`*_~|>\[\]]/g, " ")
    .replace(/[\r\n]/g, " ")
    .slice(0, 100);
export function reminderMessage(tasks: Task[], time: number) {
  const date = new Date(time + 9 * 3600000),
    today = date.toISOString().slice(0, 10);
  const ranked = rankTasks(tasks, today),
    next = ranked[0];
  const due = ranked.filter((t) => t.due === today),
    overdue = ranked.filter((t) => t.due && t.due < today);
  const list = (items: Task[]) =>
    items.length
      ? items
          .slice(0, 7)
          .map(
            (t) =>
              `・${safe(t.text)}${t.importance === "high" ? "（重要）" : ""}`,
          )
          .join("\n") + (items.length > 7 ? `\nほか${items.length - 7}件` : "")
      : "なし";
  return {
    content: `**${today} ${String(date.getUTCHours()).padStart(2, "0")}:00（日本時間）**\n\n**今すぐやること**\n${next ? `${safe(next.text)}\n理由：${recommend(tasks, today)!.reason}\nまず10分取り組む` : "着手できる未完了タスクはありません"}\n\n**今日やること（今日が期日） ${due.length}件**\n${list(due)}\n\n**期限超過 ${overdue.length}件**\n${list(overdue)}\n\n[Nowを開く](https://now-task.now-task.workers.dev/)`,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: "10分だけ始める",
            custom_id: "now:start",
          },
          { type: 2, style: 2, label: "クイックメモ", custom_id: "now:memo" },
        ],
      },
    ],
  };
}
export async function discordApi(
  env: Env,
  token: string,
  path: string,
  body?: unknown,
) {
  if (
    !env.DISCORD_CHANNEL_ID ||
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_APPLICATION_ID
  )
    throw Error("Discordの公開設定が必要です。");
  let response: Response;
  try {
    response = await fetch(`https://discord.com/api/v10${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw Error(
      "Discordへの送信結果を確認できませんでした。チャンネルを確認してください。",
    );
  }
  if (!response.ok) {
    if (response.status === 401)
      throw Error("Botトークンが無効です。登録し直してください。");
    if ([403, 404].includes(response.status))
      throw Error(
        "Botをサーバーに追加し、kusanoの閲覧・メッセージ送信権限を許可してください。",
      );
    throw Error(`Discordの処理に失敗しました（${response.status}）。`);
  }
  return response.json() as Promise<any>;
}
type Setting = { user_id: string; token_cipher: string };
async function deliver(
  env: Env,
  setting: Setting,
  time: number,
  nonce: string,
) {
  const rows = await env.DB.prepare("SELECT data FROM tasks WHERE user_id=?")
    .bind(setting.user_id)
    .all<{ data: string }>();
  const token = await decryptNotionToken(
    env,
    setting.user_id,
    setting.token_cipher,
  );
  await discordApi(env, token, `/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    ...reminderMessage(
      rows.results.map((r) => JSON.parse(r.data)),
      time,
    ),
    nonce,
    enforce_nonce: true,
  });
  await env.DB.prepare(
    "UPDATE discord_reminders SET last_sent=?,last_error=NULL WHERE user_id=?",
  )
    .bind(Date.now(), setting.user_id)
    .run();
}
export async function sendScheduledReminders(env: Env, time: number) {
  const slot = reminderSlot(time);
  if (!slot || Date.now() - time > 300000) return;
  const settings = await env.DB.prepare(
    "SELECT r.user_id,r.token_cipher FROM discord_reminders r JOIN discord_links l ON l.user_id=r.user_id WHERE r.enabled=1",
  ).all<Setting>();
  for (const setting of settings.results) {
    const claimed = await env.DB.prepare(
      "INSERT OR IGNORE INTO discord_reminder_deliveries(user_id,slot,status) VALUES(?,?,'sending') RETURNING slot",
    )
      .bind(setting.user_id, slot)
      .first();
    if (!claimed) continue;
    try {
      await deliver(
        env,
        setting,
        time,
        (await hash(`${setting.user_id}:${slot}`)).slice(0, 24),
      );
      await env.DB.prepare(
        "UPDATE discord_reminder_deliveries SET status='sent' WHERE user_id=? AND slot=?",
      )
        .bind(setting.user_id, slot)
        .run();
    } catch (e) {
      await env.DB.prepare(
        "UPDATE discord_reminders SET last_error=? WHERE user_id=?",
      )
        .bind((e as Error).message, setting.user_id)
        .run();
      await env.DB.prepare(
        "UPDATE discord_reminder_deliveries SET status='failed' WHERE user_id=? AND slot=?",
      )
        .bind(setting.user_id, slot)
        .run();
    }
  }
  await env.DB.prepare("DELETE FROM discord_reminder_deliveries WHERE slot<?")
    .bind(new Date(time - 90 * 86400000).toISOString().slice(0, 10))
    .run();
}
const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
router.get("/", async (c) =>
  c.json(
    (await c.env.DB.prepare(
      "SELECT enabled,last_sent,last_error FROM discord_reminders WHERE user_id=?",
    )
      .bind(c.get("user").id)
      .first()) ?? { enabled: false },
  ),
);
router.post("/", async (c) => {
  const body = z
    .object({
      token: z
        .string()
        .trim()
        .min(20)
        .max(500)
        .regex(/^[A-Za-z0-9_.-]+$/),
    })
    .safeParse(await c.req.json());
  if (!body.success)
    return c.json({ error: "Botトークンを確認してください。" }, 400);
  const user = c.get("user").id;
  if (
    !(await c.env.DB.prepare(
      "SELECT user_id FROM discord_links WHERE user_id=?",
    )
      .bind(user)
      .first())
  )
    return c.json({ error: "先にDiscordアカウントを連携してください。" }, 400);
  try {
    const bot = await discordApi(c.env, body.data.token, "/users/@me");
    if (!bot.bot || bot.id !== c.env.DISCORD_APPLICATION_ID)
      throw Error("NowのBotトークンを使ってください。");
    const channel = await discordApi(
      c.env,
      body.data.token,
      `/channels/${c.env.DISCORD_CHANNEL_ID}`,
    );
    if (channel.guild_id !== c.env.DISCORD_GUILD_ID)
      throw Error("送信先のサーバーが一致しません。");
    const cipher = await encryptNotionToken(c.env, user, body.data.token);
    await c.env.DB.prepare(
      "INSERT INTO discord_reminders(user_id,token_cipher) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET token_cipher=excluded.token_cipher,enabled=1,last_error=NULL",
    )
      .bind(user, cipher)
      .run();
    return c.json({ enabled: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
router.post("/stop", async (c) => {
  await c.env.DB.prepare("DELETE FROM discord_reminders WHERE user_id=?")
    .bind(c.get("user").id)
    .run();
  return c.json({ enabled: false });
});
router.post("/test", async (c) => {
  const setting = await c.env.DB.prepare(
    "UPDATE discord_reminders SET last_test=? WHERE user_id=? AND last_test<? RETURNING user_id,token_cipher",
  )
    .bind(Date.now(), c.get("user").id, Date.now() - 60000)
    .first<Setting>();
  if (!setting)
    return c.json(
      { error: "登録後にお試しください。テスト送信は1分に1回です。" },
      429,
    );
  try {
    await deliver(
      c.env,
      setting,
      Date.now(),
      crypto.randomUUID().replaceAll("-", "").slice(0, 24),
    );
    return c.json({ sent: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
export default router;
