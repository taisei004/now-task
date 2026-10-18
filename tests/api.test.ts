import { beforeEach, describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import app from "../worker/index";
import { hash, type Env } from "../worker/auth";
import { dateKey, newTask } from "../shared/tasks";
// Run the actual migration and SQL against SQLite, the D1 storage engine.
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../migrations/0001_init.sql", import.meta.url),
      "utf8",
    ),
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
      await (await request("/api/tasks", undefined, "bob")).json(),
    ).toEqual({ tasks: [] });
  });
  it("同じidでも他ユーザーのタスクを変更しない", async () => {
    const t = newTask("alice");
    await request("/api/sync", { tasks: [t] });
    await request("/api/sync", { tasks: [{ ...t, text: "bob" }] }, "bob");
    expect(
      (
        (await (await request("/api/tasks")).json()) as {
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
  it("保存とステータス更新が永続化される", async () => {
    const t = newTask("仕事");
    await request("/api/sync", { tasks: [t] });
    await request("/api/sync", { tasks: [{ ...t, status: "done" }] });
    expect(
      (
        (await (await request("/api/tasks")).json()) as {
          tasks: { status: string }[];
        }
      ).tasks[0].status,
    ).toBe("done");
  });
  it("タスクなしならAIを呼ばない", async () => {
    expect(
      await (await request("/api/next", { today: dateKey() })).json(),
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
      ).json()) as { recommendation: { source: string } };
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
    ).json()) as {
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
    ).json()) as { recommendation: { source: string } };
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
    ).json()) as { recommendation: { taskId: string } };
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
    ).json()) as { recommendation: { source: string; taskId: string } };
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
    ).json()) as { recommendation: { source: string; warning: string } };
    expect(r.recommendation.source).toBe("rules");
    expect(r.recommendation.warning).toContain("利用上限");
    expect(ai).not.toHaveBeenCalled();
  });
});
