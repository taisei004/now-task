import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import app from "../worker/index";
import { hash, type Env } from "../worker/auth";
import { dateKey, newTask, rankTasks } from "../shared/tasks";
import { validDiscordSignature } from "../worker/discord";
// Run the actual migration and SQL against SQLite, the D1 storage engine.
function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(
      readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
    );
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        args = values;
        return statement;
      },
      async first() {
        return db.prepare(sql).get(...(args as never[])) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...(args as never[])) };
      },
      async run() {
        return db.prepare(sql).run(...(args as never[]));
      },
    };
    return statement;
  };
  return {
    db,
    binding: {
      prepare,
      async batch(statements: { run: () => unknown }[]) {
        db.exec("BEGIN");
        try {
          const result = [];
          for (const s of statements) result.push(await s.run());
          db.exec("COMMIT");
          return result;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    } as unknown as D1Database,
  };
}
let env: Env, db: DatabaseSync, ai: ReturnType<typeof vi.fn>;
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  const databaseInstance = database();
  db = databaseInstance.db;
  ai = vi.fn();
  env = {
    DB: databaseInstance.binding,
    AI: { run: ai } as unknown as Ai,
    ASSETS: {} as Fetcher,
  };
  for (const id of ["alice", "bob"]) {
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      `${id}@example.test`,
      id,
      Date.now(),
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      await hash(`${id}-token`),
      id,
      Date.now() + 600000,
    );
  }
});
function request(
  path: string,
  body?: unknown,
  user = "alice",
  origin = "https://now.example",
) {
  const headers: Record<string, string> = {
    Cookie: `now_session=${user}-token`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin = origin;
  }
  return app.request(
    `https://now.example${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
describe("認証・権限", () => {
  it("未ログインを拒否", async () =>
    expect(
      (await app.request("https://now.example/api/tasks", {}, env)).status,
    ).toBe(401));
  it("期限切れセッションを拒否", async () => {
    db.prepare("UPDATE sessions SET expires_at=0").run();
    expect((await request("/api/tasks")).status).toBe(401);
  });
  it("他サイトからの書き込みを拒否", async () =>
    expect(
      (
        await request(
          "/api/sync",
          { tasks: [] },
          "alice",
          "https://evil.example",
        )
      ).status,
    ).toBe(403));
  it("不正なタスクを拒否", async () =>
    expect(
      (await request("/api/sync", { tasks: [{ text: "bad" }] })).status,
    ).toBe(400));
  it("他ユーザーのタスクを返さない", async () => {
    const t = newTask("private");
    await request("/api/sync", { tasks: [t] });
    expect(
      await (await request("/api/tasks", undefined, "bob")).json<any>(),
    ).toEqual({ tasks: [], complete: true });
  });
  it("同じidでも他ユーザーのタスクを変更しない", async () => {
    const t = newTask("alice");
    await request("/api/sync", { tasks: [t] });
    await request("/api/sync", { tasks: [{ ...t, text: "bob" }] }, "bob");
    expect(
      (
        (await (await request("/api/tasks")).json<any>()) as {
          tasks: { text: string }[];
        }
      ).tasks[0].text,
    ).toBe("alice");
  });
  it("ログアウトでセッションを失効", async () => {
    expect((await request("/api/logout", {})).status).toBe(200);
    expect((await request("/api/tasks")).status).toBe(401);
  });
  it("Google未設定時に偽ログインしない", async () => {
    const r = await request("/auth/google");
    expect(r.headers.get("location")).toBe("/?auth=unconfigured");
  });
  it("不正OAuth stateを拒否", async () => {
    env.APP_ORIGIN = "https://now.example";
    env.GOOGLE_CLIENT_ID = "test";
    env.GOOGLE_CLIENT_SECRET = "test";
    const r = await request("/auth/google/callback?state=bad&code=bad");
    expect(r.headers.get("location")).toBe("/?auth=failed");
  });
});
describe("同期・Workers AI", () => {
  it("取得上限による部分応答を完全な一覧と区別する", async () => {
    const insert = db.prepare(
      "INSERT INTO tasks(user_id,id,data,updated_at) VALUES(?,?,?,?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 5001; i++) {
      const task = newTask(`タスク${i}`);
      insert.run("alice", task.id, JSON.stringify(task), i);
    }
    db.exec("COMMIT");
    const response = (await (await request("/api/tasks")).json<any>()) as {
      tasks: unknown[];
      complete: boolean;
    };
    expect(response.tasks).toHaveLength(5000);
    expect(response.complete).toBe(false);
  });
  it("保存とステータス更新が永続化される", async () => {
    const t = newTask("仕事");
    await request("/api/sync", { tasks: [t] });
    await request("/api/sync", { tasks: [{ ...t, status: "done" }] });
    expect(
      (
        (await (await request("/api/tasks")).json<any>()) as {
          tasks: { status: string }[];
        }
      ).tasks[0].status,
    ).toBe("done");
  });
  it("タスクなしならAIを呼ばない", async () => {
    expect(
      await (await request("/api/next", { today: dateKey() })).json<any>(),
    ).toEqual({ recommendation: null });
    expect(ai).not.toHaveBeenCalled();
  });
  it("モデルの理由を返し同一入力をキャッシュ", async () => {
    const t = newTask("企画書");
    await request("/api/sync", { tasks: [t] });
    ai.mockResolvedValue({
      response: JSON.stringify({
        taskId: t.id,
        reason: "登録が早い仕事です。",
        firstStep: "10分だけ進める",
      }),
    });
    for (let i = 0; i < 2; i++) {
      const r = (await (
        await request("/api/next", { today: dateKey() })
      ).json<any>()) as { recommendation: { source: string } };
      expect(r.recommendation.source).toBe("ai");
    }
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("存在しないタスクをAIが返したらルールへ切替", async () => {
    const t = newTask("企画書");
    await request("/api/sync", { tasks: [t] });
    ai.mockResolvedValue({
      response: JSON.stringify({
        taskId: "hallucination",
        reason: "理由",
        firstStep: "10分",
      }),
    });
    const result = (await (
      await request("/api/next", { today: dateKey() })
    ).json<any>()) as {
      recommendation: { taskId: string; source: string; warning: string };
    };
    expect(result.recommendation.taskId).toBe(t.id);
    expect(result.recommendation.source).toBe("rules");
    expect(result.recommendation.warning).toContain("AIに接続できない");
  });
  it("AI障害でも推薦を返す", async () => {
    await request("/api/sync", { tasks: [newTask("仕事")] });
    ai.mockRejectedValue(Error("unavailable"));
    const r = (await (
      await request("/api/next", { today: dateKey() })
    ).json<any>()) as { recommendation: { source: string } };
    expect(r.recommendation.source).toBe("rules");
  });
  it("AIが当日期限を後回しにするのを防ぐ", async () => {
    const urgent = { ...newTask("期限"), due: dateKey() },
      other = newTask("後でもよい");
    await request("/api/sync", { tasks: [urgent, other] });
    ai.mockResolvedValue({
      response: JSON.stringify({
        taskId: other.id,
        reason: "理由",
        firstStep: "10分",
      }),
    });
    const r = (await (
      await request("/api/next", { today: dateKey() })
    ).json<any>()) as { recommendation: { taskId: string } };
    expect(r.recommendation.taskId).toBe(urgent.id);
  });
  it("任意の日付でAI上限を回避できない", async () =>
    expect((await request("/api/next", { today: "2030-01-01" })).status).toBe(
      400,
    ));
  it("Workers AIの構造化JSON応答も受け取る", async () => {
    const t = newTask("構成をまとめる");
    await request("/api/sync", { tasks: [t] });
    ai.mockResolvedValue({
      response: {
        taskId: t.id,
        reason: "先に登録したタスクです。",
        firstStep: "10分取り組む",
      },
    });
    const r = (await (
      await request("/api/next", { today: dateKey() })
    ).json<any>()) as { recommendation: { source: string; taskId: string } };
    expect(r.recommendation.source).toBe("ai");
    expect(r.recommendation.taskId).toBe(t.id);
  });
  it("AI利用上限でモデルを呼ばない", async () => {
    await request("/api/sync", { tasks: [newTask("仕事")] });
    db.prepare("INSERT INTO ai_usage VALUES(?,?,100)").run(
      "alice",
      new Date().toISOString().slice(0, 10),
    );
    const r = (await (
      await request("/api/next", { today: dateKey() })
    ).json<any>()) as { recommendation: { source: string; warning: string } };
    expect(r.recommendation.source).toBe("rules");
    expect(r.recommendation.warning).toContain("利用上限");
    expect(ai).not.toHaveBeenCalled();
  });
});

describe("共有タイマーとタグ", () => {
  it("期日・重要度・色タグを保存し他ユーザーには公開しない", async () => {
    const task = {
      ...newTask("共有しないメモ"),
      due: "2026-11-03",
      importance: "high",
      tags: [{ name: "企画", color: "rose" }],
    };
    expect((await request("/api/sync", { tasks: [task] })).status).toBe(200);
    expect((await (await request("/api/tasks")).json<any>()).tasks[0]).toEqual(
      task,
    );
    expect(
      (await (await request("/api/tasks", undefined, "bob")).json<any>()).tasks,
    ).toHaveLength(0);
    expect(
      (
        await request("/api/sync", {
          tasks: [{ ...task, tags: [{ name: "不正", color: "red" }] }],
        })
      ).status,
    ).toBe(400);
  });
  it("所有するタスクだけ開始でき、古いリビジョンは拒否する", async () => {
    const task = newTask("10分");
    await request("/api/sync", { tasks: [task] });
    const focus = {
      taskId: task.id,
      remaining: 600,
      endsAt: Date.now() + 600000,
    };
    expect(
      (await request("/api/focus", { focus, version: 0 }, "bob")).status,
    ).toBe(400);
    expect(
      (await request("/api/focus", { focus, version: 0 }, "")).status,
    ).toBe(401);
    const first = await (
      await request("/api/focus", { focus, version: 0 })
    ).json<any>();
    expect(first.version).toBe(1);
    expect(
      (await request("/api/focus", { focus: null, version: 0 })).status,
    ).toBe(409);
    const paused = await (
      await request("/api/focus", {
        focus: { ...focus, remaining: 510, endsAt: null },
        version: 1,
      })
    ).json<any>();
    expect(paused.version).toBe(2);
    expect(
      (await (await request("/api/focus")).json<any>()).focus.remaining,
    ).toBe(510);
    expect(
      (await (await request("/api/focus", undefined, "bob")).json<any>()).focus,
    ).toBeNull();
    expect(
      (await request("/api/focus", { focus: null, version: 2 })).status,
    ).toBe(200);
    expect((await (await request("/api/focus")).json<any>()).focus).toBeNull();
  });
  it("完了タスクのタイマーを復活させない", async () => {
    const task = newTask("完了後");
    await request("/api/sync", { tasks: [task] });
    await request("/api/focus", {
      focus: { taskId: task.id, remaining: 600, endsAt: Date.now() + 600000 },
      version: 0,
    });
    await request("/api/sync", { tasks: [{ ...task, status: "done" }] });
    expect((await (await request("/api/focus")).json<any>()).focus).toBeNull();
  });
});

describe("Discord署名とアカウント分離", () => {
  let privateKey: CryptoKey,
    publicKey: string,
    counter = 10000;
  const hex = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("hex");
  beforeEach(async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
    Object.assign(env, {
      DISCORD_PUBLIC_KEY: publicKey,
      DISCORD_APPLICATION_ID: "app",
      DISCORD_GUILD_ID: "guild",
      DISCORD_CHANNEL_ID: "channel",
      APP_ORIGIN: "https://now.example",
    });
  });
  const event = (type: number, data?: unknown) => ({
    id: String(++counter),
    application_id: "app",
    type,
    guild_id: "guild",
    channel_id: "channel",
    member: { user: { id: "discord-alice" }, permissions: "32" },
    data,
  });
  async function signed(
    value: unknown,
    timestamp = String(Math.floor(Date.now() / 1000)),
  ) {
    const body = JSON.stringify(value),
      signature = hex(
        await crypto.subtle.sign(
          "Ed25519",
          privateKey,
          new TextEncoder().encode(timestamp + body),
        ),
      );
    return app.request(
      "https://now.example/discord/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Timestamp": timestamp,
          "X-Signature-Ed25519": signature,
        },
        body,
      },
      env,
    );
  }
  const command = (name: string, options?: unknown[]) =>
    event(2, { name: "now", options: [{ name, options }] });
  const link = () =>
    db
      .prepare("INSERT INTO discord_links VALUES(?,?,?)")
      .run("discord-alice", "alice", Date.now());
  it("正しい署名のPINGだけ応答する", async () => {
    expect(await (await signed({ type: 1 })).json<any>()).toEqual({ type: 1 });
    expect(
      (await signed({ type: 1 }, String(Math.floor(Date.now() / 1000) - 301)))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "https://now.example/discord/interactions",
          { method: "POST", body: "{}" },
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      await validDiscordSignature(
        publicKey,
        "0".repeat(128),
        String(Math.floor(Date.now() / 1000)),
        "{}",
      ),
    ).toBe(false);
  });
  it("一度限りのコードをハッシュで保存し連携・解除する", async () => {
    const { code } = await (await request("/api/discord/link", {})).json<any>();
    expect(
      db.prepare("SELECT hash FROM discord_link_codes").get()?.hash,
    ).not.toBe(code);
    const response = await (
      await signed(command("link", [{ name: "code", value: code }]))
    ).json<any>();
    expect(response.data.flags).toBe(64);
    expect(response.data.content).toContain("連携しました");
    expect((await (await request("/api/discord")).json<any>()).linked).toBe(
      true,
    );
    expect(
      (await (await request("/api/discord", undefined, "bob")).json<any>())
        .linked,
    ).toBe(false);
    expect(db.prepare("SELECT * FROM discord_link_codes").all()).toHaveLength(
      0,
    );
    await request("/api/discord/unlink", {});
    expect(
      (
        await (
          await signed(command("link", [{ name: "code", value: code }]))
        ).json<any>()
      ).data.content,
    ).toContain("無効");
  });
  it("期限切れコードと別チャンネルの要求を拒否する", async () => {
    const { code } = await (await request("/api/discord/link", {})).json<any>();
    db.prepare("UPDATE discord_link_codes SET expires_at=0").run();
    expect(
      (
        await (
          await signed(command("link", [{ name: "code", value: code }]))
        ).json<any>()
      ).data.content,
    ).toContain("期限切れ");
    const other = { ...command("memo"), channel_id: "other" };
    expect((await (await signed(other)).json<any>()).data.content).toContain(
      "設定された",
    );
    expect(db.prepare("SELECT * FROM tasks").all()).toHaveLength(0);
  });
  it("未連携ユーザーにはタスクを表示しない", async () => {
    await request("/api/sync", { tasks: [newTask("秘密の仕事")] });
    const result = await (await signed(command("start"))).json<any>();
    expect(result.data.content).toContain("連携コード");
    expect(JSON.stringify(result)).not.toContain("秘密");
  });
  it("Webで表示中の有効なAI推薦をDiscordでも使う", async () => {
    link();
    const first = newTask("先に登録", Date.now() - 1000),
      second = newTask("AIが選んだ仕事");
    await request("/api/sync", { tasks: [first, second] });
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
    }).format(new Date());
    const fingerprint = await hash(
      JSON.stringify([today, rankTasks([first, second], today)]),
    );
    db.prepare("INSERT INTO ai_cache VALUES(?,?,?,?)").run(
      "alice",
      fingerprint,
      JSON.stringify({
        taskId: second.id,
        reason: "Webと同じ推薦理由",
        source: "ai",
        firstStep: "10分取り組む",
      }),
      Date.now(),
    );
    const result = await (await signed(command("start"))).json<any>();
    expect(result.data.content).toContain(second.text);
    expect(result.data.content).toContain("Webと同じ推薦理由");
  });
  it("ボタンで所有タスクの10分タイマーを開始しWeb APIに反映する", async () => {
    link();
    const task = newTask("期限の近い仕事");
    await request("/api/sync", { tasks: [task] });
    await request(
      "/api/sync",
      { tasks: [{ ...newTask("別ユーザー"), importance: "high" }] },
      "bob",
    );
    const response = await (
      await signed(event(3, { custom_id: "now:start" }))
    ).json<any>();
    expect(response.data.flags).toBe(64);
    expect(response.data.content).toContain(task.text);
    const state = await (await request("/api/focus")).json<any>();
    expect(state.focus.taskId).toBe(task.id);
    expect(state.focus.endsAt - Date.now()).toBeGreaterThan(598000);
    expect(
      (await (await request("/api/focus", undefined, "bob")).json<any>()).focus,
    ).toBeNull();
  });
  it("メモモーダルと期日・重要度・色タグを保存し二重送信を防ぐ", async () => {
    link();
    expect(
      (await (await signed(event(3, { custom_id: "now:memo" }))).json<any>())
        .type,
    ).toBe(9);
    const memo = event(5, {
      custom_id: "now:memo",
      components: [
        {
          components: [
            { custom_id: "text", value: "Discordから @everyone メモ" },
            { custom_id: "due", value: "2026-12-01" },
            { custom_id: "importance", value: "重要" },
            { custom_id: "tag", value: "企画" },
            { custom_id: "color", value: "ピンク" },
          ],
        },
      ],
    });
    const result = await (await signed(memo)).json<any>();
    expect(result.data.flags).toBe(64);
    expect(result.data.allowed_mentions.parse).toEqual([]);
    const task = (await (await request("/api/tasks")).json<any>()).tasks[0];
    expect(task).toMatchObject({
      due: "2026-12-01",
      importance: "high",
      tags: [{ name: "企画", color: "rose" }],
    });
    expect((await (await signed(memo)).json<any>()).data.content).toContain(
      "処理済み",
    );
    expect(db.prepare("SELECT * FROM tasks").all()).toHaveLength(1);
    expect(
      (await (await request("/api/tasks", undefined, "bob")).json<any>()).tasks,
    ).toHaveLength(0);
  });
  it("存在しない期日のメモは保存しない", async () => {
    link();
    const memo = event(5, {
      custom_id: "now:memo",
      components: [
        {
          components: [
            { custom_id: "text", value: "日付エラー" },
            { custom_id: "due", value: "2026-02-30" },
          ],
        },
      ],
    });
    expect((await (await signed(memo)).json<any>()).data.content).toContain(
      "期日",
    );
    expect(db.prepare("SELECT * FROM tasks").all()).toHaveLength(0);
  });
  it("パネルは管理者のみ設置し、共通ボタンに個人データを含めない", async () => {
    const result = await (await signed(command("panel"))).json<any>();
    expect(
      result.data.components[0].components.map(
        (c: { label: string }) => c.label,
      ),
    ).toEqual(["10分だけ始める", "クイックメモ"]);
    expect(result.data.flags).toBeUndefined();
    const ordinary = command("panel");
    ordinary.member.permissions = "0";
    expect((await (await signed(ordinary)).json<any>()).data.content).toContain(
      "管理権限",
    );
  });
});

describe("Discordの初回コマンド登録", () => {
  it("未認証やTokenのないリクエストを拒否する", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await request("/api/discord/register", {}, "")).status).toBe(401);
    expect((await request("/api/discord/register", {})).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("指定されたアプリとサーバーにだけ登録しTokenは保存も返却もしない", async () => {
    Object.assign(env, {
      DISCORD_APPLICATION_ID: "1561466054452969512",
      DISCORD_GUILD_ID: "1433011113599045704",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ id: "command" }));
    vi.stubGlobal("fetch", fetchMock);
    const token = "fake-token-for-testing-only";
    const result = await request("/api/discord/register", { token });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://discord.com/api/v10/applications/1561466054452969512/guilds/1433011113599045704/commands",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      `Bot ${token}`,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).name).toBe("now");
    expect(db.prepare("SELECT * FROM users").all()).toHaveLength(2);
    expect(db.prepare("SELECT * FROM discord_links").all()).toHaveLength(0);
  });
  it("Discordの認証エラーを成功表示しない", async () => {
    Object.assign(env, {
      DISCORD_APPLICATION_ID: "1561466054452969512",
      DISCORD_GUILD_ID: "1433011113599045704",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 401 })),
    );
    const result = await request("/api/discord/register", {
      token: "fake-token-for-testing-only",
    });
    expect(result.status).toBe(502);
    expect((await result.json<any>()).error).toContain("401");
  });
});
