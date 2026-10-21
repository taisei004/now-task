import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { database } from "./helpers/database";
import {
  NotionClient,
  encryptNotionToken,
  decryptNotionToken,
  notionText,
  type NotionPage,
} from "../worker/notion-client";
import {
  syncNotion,
  taskCore,
  mergeCores,
  taskFromNotion,
  notionProperties,
} from "../worker/notion-sync";
import { newTask, rankTasks, type Task } from "../shared/tasks";
import { hash, type Env } from "../worker/auth";
import app from "../worker/index";
const root = "11111111-1111-4111-8111-111111111111",
  tasks = "22222222-2222-4222-8222-222222222222",
  projects = "33333333-3333-4333-8333-333333333333";
const token = "test-only-notion-token-not-a-secret";
let db: ReturnType<typeof database>["db"],
  env: Env,
  remote: Map<string, NotionPage>,
  calls: { path: string; method: string; body: any }[],
  summary: string,
  spy: import("vitest").MockInstance<NotionClient["call"]>,
  options: { name: string; color: string; id?: string }[];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const page = (task: Task, id = crypto.randomUUID()): NotionPage => ({
  id,
  last_edited_time: new Date().toISOString(),
  properties: {
    ...notionProperties(task),
    "Now ID": { rich_text: [{ text: { content: task.id } }] },
    入力元: { select: { name: "Now" } },
    案件: { relation: [] },
  },
});
function save(task: Task, user = "alice") {
  db.prepare(
    "INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
  ).run(user, task.id, JSON.stringify(task), Date.now());
}
function local(user = "alice"): Task[] {
  return db
    .prepare("SELECT data FROM tasks WHERE user_id=?")
    .all(user)
    .map((r) => JSON.parse(String(r.data)));
}
async function connection() {
  db.prepare(
    "INSERT INTO notion_connections(user_id,token_cipher,root_page_id,task_source_id,project_source_id,summary_page_id,summary_block_id) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "alice",
    await encryptNotionToken(env, "alice", token),
    root,
    tasks,
    projects,
    "summary",
    "block",
  );
}
function request(
  path: string,
  body?: unknown,
  user = "alice",
  origin = "https://now.example",
) {
  return app.request(
    `https://now.example${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: `now_session=${user}-token`,
        ...(body === undefined
          ? {}
          : { Origin: origin, "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
beforeEach(async () => {
  const instance = database();
  db = instance.db;
  remote = new Map();
  calls = [];
  summary = "";
  options = [{ name: "仕事", color: "blue" }];
  env = {
    DB: instance.binding,
    ASSETS: {} as Fetcher,
    AI: {
      run: vi.fn().mockRejectedValue(Error("Unavailable")),
    } as unknown as Ai,
    NOTION_ENCRYPTION_KEY: btoa("k".repeat(32)),
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
  spy = vi
    .spyOn(NotionClient.prototype, "call")
    .mockImplementation(async (path: string, method = "GET", body?: any) => {
      calls.push({ path, method, body: clone(body ?? null) });
      if (path === `/pages/${root}`) return { id: root };
      if (path === `/data_sources/${projects}/query`)
        return {
          results: [
            {
              id: "project-a",
              properties: {
                案件名: { title: [{ text: { content: "制作案件" } }] },
              },
            },
          ],
          has_more: false,
        };
      if (path === `/data_sources/${tasks}/query`) {
        let list = [...remote.values()];
        if (body?.filter)
          list = list.filter(
            (p) =>
              notionText(p.properties["Now ID"]) ===
              body.filter.rich_text.equals,
          );
        return { results: clone(list), has_more: false };
      }
      if (path === `/data_sources/${tasks}` && method === "PATCH") {
        options = body.properties["タグ"].multi_select.options;
        return {};
      }
      if (path === `/data_sources/${tasks}`)
        return {
          parent: { database_id: "tasks-db" },
          properties: {
            ...Object.fromEntries(
              Object.entries({
                タスク名: "title",
                状況: "status",
                期日: "date",
                重要度: "select",
                タグ: "multi_select",
                案件: "relation",
                要確認: "checkbox",
                元のメモ: "rich_text",
                保留理由: "rich_text",
                "着手時間（分）": "number",
                "Now ID": "rich_text",
                入力元: "select",
              }).map(([name, type]) => [name, { type }]),
            ),
            タグ: {
              type: "multi_select",
              multi_select: { options: clone(options) },
            },
          },
        };
      if (path === `/data_sources/${projects}`)
        return {
          parent: { database_id: "projects-db" },
          properties: { 案件名: { type: "title" } },
        };
      if (path === "/databases/tasks-db" || path === "/databases/projects-db")
        return { parent: { page_id: root } };
      if (path === "/pages" && method === "POST") {
        if (body.parent.page_id) return { id: "summary" };
        const id = crypto.randomUUID(),
          p = {
            id,
            last_edited_time: new Date().toISOString(),
            properties: clone(body.properties),
          };
        for (const tag of p.properties["タグ"]?.multi_select ?? [])
          tag.color = options.find((o) => o.name === tag.name)?.color ?? "gray";
        remote.set(id, p);
        return clone(p);
      }
      if (path === "/blocks/summary/children")
        return { results: [{ id: "block" }] };
      if (path === "/blocks/block" && method === "PATCH") {
        summary = body.paragraph.rich_text
          .map((t: any) => t.text.content)
          .join("");
        return {};
      }
      const id = path.split("/")[2];
      if (remote.has(id)) {
        const p = remote.get(id)!;
        if (method === "PATCH") {
          Object.assign(p.properties, clone(body.properties));
          for (const tag of p.properties["タグ"]?.multi_select ?? [])
            tag.color =
              options.find((o) => o.name === tag.name)?.color ?? "gray";
          p.last_edited_time = new Date(
            Date.now() + calls.length,
          ).toISOString();
        }
        return clone(p);
      }
      throw Error(`Unexpected mock request: ${method} ${path}`);
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});
describe("Notion接続の保護", () => {
  it("接続キーを暗号化し別ユーザーでは復号できない", async () => {
    const cipher = await encryptNotionToken(env, "alice", token);
    expect(cipher).not.toContain(token);
    expect(await decryptNotionToken(env, "alice", cipher)).toBe(token);
    await expect(decryptNotionToken(env, "bob", cipher)).rejects.toThrow(
      "接続",
    );
  });
  it("未認証・別Originを拒否し接続状態に秘密を返さない", async () => {
    await connection();
    expect((await request("/api/notion", undefined, "")).status).toBe(401);
    expect(
      (await request("/api/notion/sync", {}, "alice", "https://evil.test"))
        .status,
    ).toBe(403);
    const a = await (await request("/api/notion")).json<any>(),
      b = await (await request("/api/notion", undefined, "bob")).json<any>();
    expect(a.connected).toBe(true);
    expect(b.connected).toBe(false);
    expect(JSON.stringify(a)).not.toContain(token);
    expect(a.token_cipher).toBeUndefined();
  });
  it("ページと項目を検証してから接続し暗号化されたキーだけ保存する", async () => {
    const response = await request("/api/notion/connect", {
      token,
      rootPageId: root,
      taskSourceId: tasks,
      projectSourceId: projects,
    });
    expect(response.status).toBe(200);
    const stored = db
      .prepare("SELECT token_cipher FROM notion_connections")
      .get();
    expect(String(stored?.token_cipher)).not.toContain(token);
    expect(
      await decryptNotionToken(env, "alice", String(stored?.token_cipher)),
    ).toBe(token);
    expect(
      (
        await request("/api/notion/connect", {
          token,
          rootPageId: root,
          taskSourceId: tasks,
          projectSourceId: projects,
        })
      ).status,
    ).toBe(409);
  });
  it("同期中の接続解除を拒否し、解除してもタスクは残す", async () => {
    await connection();
    save(newTask("保存済み"));
    db.prepare("UPDATE notion_connections SET lease_until=?").run(
      Date.now() + 60000,
    );
    expect((await request("/api/notion/disconnect", {})).status).toBe(409);
    db.prepare("UPDATE notion_connections SET lease_until=0").run();
    expect((await request("/api/notion/disconnect", {})).status).toBe(200);
    expect(local()).toHaveLength(1);
  });
});
describe("NotionとNowの同期", () => {
  it("変更のない既存行で枠を使わず初回の残りを次回へ進める", async () => {
    await connection();
    for (let i = 0; i < 15; i++) save(newTask(`タスク${i}`));
    const first = await syncNotion(env, "alice", 6);
    expect(first).toMatchObject({ pending: 9 });
    expect(remote.size).toBe(6);
    const next = await syncNotion(env, "alice", 10);
    expect(next).toMatchObject({ pending: 0 });
    expect(remote.size).toBe(15);
  });
  it("同期中のNowの新しい編集を上書きしない", async () => {
    await connection();
    const t = newTask("最初");
    save(t);
    await syncNotion(env, "alice");
    const p = [...remote.values()][0];
    save({ ...local()[0], text: "先の編集" });
    p.properties["期日"] = { date: { start: "2026-12-01" } };
    const base = spy.getMockImplementation()!;
    let changed = false;
    spy.mockImplementation(async (path, method, body) => {
      if (
        path === `/pages/${p.id}` &&
        (!method || method === "GET") &&
        !changed
      ) {
        changed = true;
        save({ ...local()[0], text: "同期中の最新編集" });
      }
      return base(path, method, body);
    });
    expect(await syncNotion(env, "alice")).toHaveProperty("error");
    expect(local()[0].text).toBe("同期中の最新編集");
  });
  it("有効なWorkers AIの要約だけを採用し同じ内容では再生成しない", async () => {
    await connection();
    const t = newTask("今日の仕事");
    save(t);
    const ai = vi.fn().mockResolvedValue({
      response: {
        priorities: [
          {
            taskId: t.id,
            reason: "作業時間を確保する",
            firstStep: "原稿を10分読む",
          },
        ],
      },
    });
    env.AI = { run: ai } as unknown as Ai;
    await syncNotion(env, "alice");
    expect(summary).toContain("Workers AIによる要約");
    expect(summary).toContain("原稿を10分読む");
    await syncNotion(env, "alice");
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("本人のタスクだけを書き出し再同期で複製しない", async () => {
    await connection();
    const t = {
      ...newTask("音声のメモ"),
      source: "voice" as const,
      tags: [{ name: "企画", color: "rose" as const }],
    };
    save(t);
    save(newTask("別ユーザー"), "bob");
    const result = await syncNotion(env, "alice");
    expect(result).not.toHaveProperty("error");
    expect(remote.size).toBe(1);
    const p = [...remote.values()][0];
    expect(notionText(p.properties["タスク名"])).toBe(t.text);
    expect(p.properties["入力元"].select.name).toBe("音声");
    expect(p.properties["タグ"].multi_select[0].color).toBe("pink");
    expect(await syncNotion(env, "alice")).not.toHaveProperty("error");
    expect(remote.size).toBe(1);
    expect(local("bob")).toHaveLength(1);
    expect(summary).toContain(t.text);
    expect(summary).toContain("期限・重要度");
  });
  it("AI会話から登録したタスクと案件名をNowへ取り込む", async () => {
    await connection();
    const t = newTask("会話からの仕事"),
      p = page(t);
    p.properties["入力元"] = { select: { name: "AI会話" } };
    p.properties["案件"] = { relation: [{ id: "project-a" }] };
    p.properties["Now ID"] = { rich_text: [] };
    remote.set(p.id, p);
    expect(await syncNotion(env, "alice")).not.toHaveProperty("error");
    const imported = local()[0];
    expect(imported).toMatchObject({
      text: t.text,
      source: "chat",
      project: "制作案件",
    });
    expect(imported.notionUrl).toContain(p.id.replaceAll("-", ""));
    expect(local("bob")).toEqual([]);
    expect(notionText(remote.get(p.id)!.properties["Now ID"])).toBe(
      imported.id,
    );
  });
  it("Nowでの完了を反映しNotionの案件・元メモを保持する", async () => {
    await connection();
    const t = newTask("仕上げ");
    save(t);
    await syncNotion(env, "alice");
    const p = [...remote.values()][0];
    p.properties["案件"] = { relation: [{ id: "project-a" }] };
    p.properties["元のメモ"] = {
      rich_text: [{ text: { content: "会話の原文は残す" } }],
    };
    save({ ...local()[0], status: "done", updatedAt: Date.now() });
    expect(await syncNotion(env, "alice")).not.toHaveProperty("error");
    expect(remote.get(p.id)!.properties["状況"].status.name).toBe("完了");
    expect(remote.get(p.id)!.properties["案件"].relation[0].id).toBe(
      "project-a",
    );
    expect(notionText(remote.get(p.id)!.properties["元のメモ"])).toBe(
      "会話の原文は残す",
    );
  });
  it("異なる項目の変更は結合し同じ項目の衝突は止めて解決できる", async () => {
    await connection();
    const t = newTask("元の名前");
    save(t);
    await syncNotion(env, "alice");
    const p = [...remote.values()][0];
    save({ ...local()[0], text: "Nowで変更" });
    p.properties["タスク名"] = {
      title: [{ text: { content: "Notionで変更" } }],
    };
    p.last_edited_time = "later";
    const result = await syncNotion(env, "alice");
    expect(result).toMatchObject({ conflicts: 1 });
    expect(local()[0].text).toBe("Nowで変更");
    expect(notionText(p.properties["タスク名"])).toBe("Notionで変更");
    expect(
      (
        await request(
          "/api/notion/resolve",
          { taskId: t.id, side: "notion" },
          "bob",
        )
      ).status,
    ).toBe(404);
    expect(
      (await request("/api/notion/resolve", { taskId: t.id, side: "notion" }))
        .status,
    ).toBe(200);
    await syncNotion(env, "alice");
    expect(local()[0].text).toBe("Notionで変更");
  });
  it("二重実行と重複Now IDを拒否する", async () => {
    await connection();
    db.prepare("UPDATE notion_connections SET lease_until=?").run(
      Date.now() + 60000,
    );
    expect(await syncNotion(env, "alice")).toEqual({ busy: true });
    expect(calls).toEqual([]);
    db.prepare("UPDATE notion_connections SET lease_until=0").run();
    const t = newTask("重複"),
      a = page(t),
      b = page(t);
    remote.set(a.id, a);
    remote.set(b.id, b);
    expect(await syncNotion(env, "alice")).toHaveProperty("error");
    expect(local()).toEqual([]);
  });
  it("要確認のメモを勝手に優先タスクにしない", () => {
    const t = newTask("曖昧なメモ"),
      p = page(t);
    p.properties["要確認"] = { checkbox: true };
    const imported = taskFromNotion(p, t.id, new Map())!;
    expect(imported.needsReview).toBe(true);
    expect(rankTasks([imported])).toEqual([]);
  });
  it("3方向の比較で独立した変更を結合する", () => {
    const t = newTask("元のメモ"),
      base = taskCore(t),
      l = { ...base, text: "Nowの名前" },
      r = { ...base, due: "2026-11-02" };
    expect(mergeCores(base, l, r)).toEqual({
      result: { ...r, text: l.text },
      conflicts: [],
    });
    expect(
      mergeCores(base, l, { ...base, text: "Notionの名前" }).conflicts,
    ).toEqual(["text"]);
  });
  it("API障害を接続状態に残しロックを解除する", async () => {
    await connection();
    spy.mockRejectedValueOnce(Error("Notionに接続できません。"));
    expect(await syncNotion(env, "alice")).toHaveProperty("error");
    const row = db
      .prepare("SELECT last_error,lease_until FROM notion_connections")
      .get();
    expect(row?.last_error).toContain("Notion");
    expect(row?.lease_until).toBe(0);
  });
});
describe("Notion HTTPクライアント", () => {
  it("一覧の全ページを取得する", async () => {
    spy
      .mockResolvedValueOnce({
        results: [page(newTask("1"))],
        has_more: true,
        next_cursor: "next",
      })
      .mockResolvedValueOnce({
        results: [page(newTask("2"))],
        has_more: false,
      });
    const rows = await new NotionClient(token).pages(tasks);
    expect(rows).toHaveLength(2);
    expect(spy.mock.calls[1][2]).toMatchObject({ start_cursor: "next" });
  });
  it("固定された公式APIへ送信しエラー本文にある秘密を表示しない", async () => {
    spy.mockRestore();
    const mock = vi
      .fn()
      .mockResolvedValue(new Response(token, { status: 401 }));
    vi.stubGlobal("fetch", mock);
    await expect(new NotionClient(token).call("/pages/test")).rejects.toThrow(
      "接続キーが無効",
    );
    expect(mock.mock.calls[0][0]).toBe("https://api.notion.com/v1/pages/test");
    expect(mock.mock.calls[0][1].headers["Notion-Version"]).toBe("2026-03-11");
    expect(mock.mock.calls[0][1].redirect).toBe("manual");
    await expect(
      new NotionClient(token).call("https://evil.test"),
    ).rejects.toThrow("操作先");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it("リダイレクト先に接続キーを転送せず停止する", async () => {
    spy.mockRestore();
    const mock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "https://other.example/" },
    }));
    vi.stubGlobal("fetch", mock);
    await expect(new NotionClient(token).call("/pages/test")).rejects.toThrow("接続先が変更");
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][1].redirect).toBe("manual");
  });
});
