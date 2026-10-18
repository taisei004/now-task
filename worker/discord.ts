import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { newTask, recommend, rankTasks, type Task } from "../shared/tasks";
import { TagsSchema } from "./schema";
import { hash, type Env } from "./auth";
import { readFocus, writeFocus } from "./focus";
const discord = new Hono<{ Bindings: Env }>();
const ephemeral = (content: string) => ({
  type: 4,
  data: { content, flags: 64, allowed_mentions: { parse: [] } },
});
const memoModal = {
  type: 9,
  data: {
    custom_id: "now:memo",
    title: "クイックメモ",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "text",
            label: "やること",
            style: 2,
            required: true,
            max_length: 2000,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "due",
            label: "期日（YYYY-MM-DD、省略可）",
            style: 1,
            required: false,
            max_length: 10,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "importance",
            label: "重要度（重要 / 通常、省略時は自動）",
            style: 1,
            required: false,
            max_length: 2,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "tag",
            label: "タグ名（省略可）",
            style: 1,
            required: false,
            max_length: 24,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "color",
            label: "色（青 / 緑 / 紫 / オレンジ / ピンク / グレー）",
            style: 1,
            required: false,
            max_length: 5,
          },
        ],
      },
    ],
  },
};
const panel = {
  type: 4,
  data: {
    content: "Now",
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
  },
};
type Interaction = {
  id?: string;
  application_id?: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string }; permissions?: string };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: { name: string; options?: { name: string; value: string }[] }[];
    components?: { components?: { custom_id: string; value: string }[] }[];
  };
};
export async function validDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
) {
  if (
    !/^[a-f\d]{64}$/i.test(publicKey) ||
    !/^[a-f\d]{128}$/i.test(signature) ||
    !/^\d{10,11}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 300000
  )
    return false;
  const bytes = (s: string) =>
    Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes(publicKey),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      bytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
discord.use(
  "*",
  bodyLimit({ maxSize: 32768, onError: (c) => c.text("Too large", 413) }),
);
discord.post("/interactions", async (c) => {
  const body = await c.req.text();
  if (
    !c.env.DISCORD_PUBLIC_KEY ||
    !(await validDiscordSignature(
      c.env.DISCORD_PUBLIC_KEY,
      c.req.header("X-Signature-Ed25519") ?? "",
      c.req.header("X-Signature-Timestamp") ?? "",
      body,
    ))
  )
    return c.text("Invalid signature", 401);
  let event: Interaction;
  try {
    event = JSON.parse(body);
  } catch {
    return c.text("Invalid JSON", 400);
  }
  if (event.type === 1) return c.json({ type: 1 });
  if (
    !c.env.DISCORD_GUILD_ID ||
    !c.env.DISCORD_CHANNEL_ID ||
    event.application_id !== c.env.DISCORD_APPLICATION_ID ||
    event.guild_id !== c.env.DISCORD_GUILD_ID ||
    event.channel_id !== c.env.DISCORD_CHANNEL_ID
  )
    return c.json(
      ephemeral("設定されたサーバーのチャンネルで使ってください。"),
    );
  if (!event.id || !/^\d{5,30}$/.test(event.id))
    return c.text("Invalid interaction", 400);
  const claimed = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO discord_interactions(id,expires_at) VALUES(?,?) RETURNING id",
  )
    .bind(event.id, Date.now() + 600000)
    .first();
  if (!claimed) return c.json(ephemeral("この操作は処理済みです。"));
  // Bounded cleanup runs with each signed request; no Discord token or message content is stored.
  await c.env.DB.prepare("DELETE FROM discord_interactions WHERE expires_at<?")
    .bind(Date.now())
    .run();
  const discordId = event.member?.user?.id ?? event.user?.id;
  if (!discordId)
    return c.json(ephemeral("Discordアカウントを確認できません。"));
  const sub = event.data?.options?.[0];
  if (event.type === 2 && event.data?.name === "now" && sub?.name === "link") {
    const code = sub.options?.find((o) => o.name === "code")?.value ?? "";
    if (!/^[a-f\d]{16}$/i.test(code))
      return c.json(
        ephemeral("Webアプリの設定から新しい連携コードを発行してください。"),
      );
    const previous = await c.env.DB.prepare(
      "SELECT user_id FROM discord_links WHERE discord_user_id=?",
    )
      .bind(discordId)
      .first();
    if (previous)
      return c.json(
        ephemeral(
          "連携済みです。変更する場合はWebアプリの設定から解除してください。",
        ),
      );
    const row = await c.env.DB.prepare(
      "DELETE FROM discord_link_codes WHERE hash=? AND expires_at>? RETURNING user_id",
    )
      .bind(await hash(code.toLowerCase()), Date.now())
      .first<{ user_id: string }>();
    if (!row)
      return c.json(
        ephemeral(
          "コードが無効か期限切れです。Webアプリで再発行してください。",
        ),
      );
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM discord_links WHERE user_id=?").bind(
        row.user_id,
      ),
      c.env.DB.prepare(
        "INSERT INTO discord_links(discord_user_id,user_id,linked_at) VALUES(?,?,?)",
      ).bind(discordId, row.user_id, Date.now()),
    ]);
    return c.json(
      ephemeral("Nowと連携しました。チャンネルのボタンが使えます。"),
    );
  }
  if (event.type === 2 && event.data?.name === "now" && sub?.name === "panel") {
    const perms = BigInt(event.member?.permissions ?? "0");
    if (!(perms & 32n) && !(perms & 8n))
      return c.json(ephemeral("パネルの設置にはサーバー管理権限が必要です。"));
    return c.json(panel);
  }
  const link = await c.env.DB.prepare(
    "SELECT user_id FROM discord_links WHERE discord_user_id=?",
  )
    .bind(discordId)
    .first<{ user_id: string }>();
  if (!link)
    return c.json(
      ephemeral(
        "Webアプリの「設定 → Discord」で連携コードを発行し、/now link code:コード で連携してください。",
      ),
    );
  const action =
    event.type === 2 && event.data?.name === "now"
      ? sub?.name
      : event.data?.custom_id?.replace("now:", "");
  if (action === "memo" && (event.type === 2 || event.type === 3))
    return c.json(memoModal);
  if (action === "memo" && event.type === 5) {
    const values = Object.fromEntries(
      (event.data?.components ?? []).flatMap((r) =>
        (r.components ?? []).map((i) => [i.custom_id, i.value?.trim() ?? ""]),
      ),
    );
    if (!values.text || values.text.length > 2000)
      return c.json(ephemeral("メモは1〜2000文字で入力してください。"));
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
    }).format(new Date());
    const task = newTask(values.text, Date.now(), today);
    if (values.due) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(values.due) ||
        !Number.isFinite(Date.parse(values.due)) ||
        new Date(values.due).toISOString().slice(0, 10) !== values.due
      )
        return c.json(
          ephemeral(
            "期日は YYYY-MM-DD で入力してください。メモを再送してください。",
          ),
        );
      task.due = values.due;
    }
    if (values.importance) {
      if (!["重要", "通常"].includes(values.importance))
        return c.json(
          ephemeral("重要度は「重要」か「通常」で入力してください。"),
        );
      task.importance = values.importance === "重要" ? "high" : "normal";
    }
    if (values.tag) {
      const colors: Record<string, string> = {
        青: "blue",
        緑: "green",
        紫: "purple",
        オレンジ: "amber",
        ピンク: "rose",
        グレー: "slate",
      };
      if (values.color && !colors[values.color])
        return c.json(ephemeral("タグの色を確認し、メモを再送してください。"));
      const tags = TagsSchema.safeParse([
        { name: values.tag, color: colors[values.color] ?? "blue" },
      ]);
      if (!tags.success)
        return c.json(ephemeral("タグ名は24文字以内で入力してください。"));
      task.tags = tags.data;
    }
    await c.env.DB.prepare(
      "INSERT INTO tasks(user_id,id,data,updated_at) VALUES(?,?,?,?)",
    )
      .bind(link.user_id, task.id, JSON.stringify(task), Date.now())
      .run();
    return c.json(ephemeral(`追加しました：${task.text.slice(0, 300)}`));
  }
  if (action === "start" && (event.type === 2 || event.type === 3)) {
    const rows = await c.env.DB.prepare(
      "SELECT data FROM tasks WHERE user_id=?",
    )
      .bind(link.user_id)
      .all<{ data: string }>();
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
    }).format(new Date());
    const tasks = rows.results.map((r) => JSON.parse(r.data) as Task),
      ranked = rankTasks(tasks, today);
    const active = await readFocus(c.env, link.user_id);
    const cached = await c.env.DB.prepare(
      "SELECT fingerprint,result FROM ai_cache WHERE user_id=? AND updated_at>?",
    )
      .bind(link.user_id, Date.now() - 3600000)
      .first<{ fingerprint: string; result: string }>();
    const cachedRecommendation =
      cached &&
      cached.fingerprint ===
        (await hash(JSON.stringify([today, ranked.slice(0, 40)])))
        ? JSON.parse(cached.result)
        : null;
    const chosen =
      ranked.find((task) => task.id === active.focus?.taskId) ??
      ranked.find((task) => task.id === cachedRecommendation?.taskId) ??
      ranked[0];
    if (!chosen)
      return c.json(
        ephemeral(
          "未完了のタスクがありません。クイックメモから追加してください。",
        ),
      );
    await writeFocus(c.env, link.user_id, {
      taskId: chosen.id,
      remaining: 600,
      endsAt: Date.now() + 600000,
    });
    return c.json({
      type: 4,
      data: {
        ...ephemeral("").data,
        content: `10分を開始しました：${chosen.text.slice(0, 300)}\n${cachedRecommendation?.taskId === chosen.id ? cachedRecommendation.reason : (recommend([chosen], today)?.reason ?? "")}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Webアプリを開く",
                url: c.env.APP_ORIGIN,
              },
            ],
          },
        ],
      },
    });
  }
  return c.json(ephemeral("この操作には対応していません。"));
});
export default discord;
