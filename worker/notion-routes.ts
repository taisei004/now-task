import { Hono } from "hono";
import { z } from "zod";
import type { Env, User } from "./auth";
import { NotionClient, encryptNotionToken } from "./notion-client";
import { syncNotion, type NotionConnection } from "./notion-sync";
const notion = new Hono<{ Bindings: Env; Variables: { user: User } }>();
const setup = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(500)
    .regex(/^[A-Za-z0-9_.-]+$/),
  rootPageId: z.uuid(),
  taskSourceId: z.uuid(),
  projectSourceId: z.uuid(),
});
notion.get("/", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT root_page_id,summary_page_id,last_sync,last_error,lease_until FROM notion_connections WHERE user_id=?",
  )
    .bind(c.get("user").id)
    .first<
      Pick<
        NotionConnection,
        | "root_page_id"
        | "summary_page_id"
        | "last_sync"
        | "last_error"
        | "lease_until"
      >
    >();
  const conflicts = await c.env.DB.prepare(
    "SELECT task_id,conflict FROM notion_task_links WHERE user_id=? AND conflict IS NOT NULL",
  )
    .bind(c.get("user").id)
    .all<{ task_id: string; conflict: string }>();
  return c.json({
    available: !!c.env.NOTION_ENCRYPTION_KEY,
    connected: !!row,
    ...(row
      ? {
          rootUrl: `https://www.notion.so/${row.root_page_id.replaceAll("-", "")}`,
          summaryUrl: `https://www.notion.so/${row.summary_page_id.replaceAll("-", "")}`,
          lastSync: row.last_sync,
          error: row.last_error,
          syncing: row.lease_until > Date.now(),
        }
      : {}),
    conflicts: conflicts.results.map((r) => ({
      taskId: r.task_id,
      ...JSON.parse(r.conflict),
    })),
  });
});
notion.post("/connect", async (c) => {
  if (!c.env.NOTION_ENCRYPTION_KEY)
    return c.json({ error: "Notion接続の暗号化設定が必要です。" }, 503);
  const body = setup.safeParse(await c.req.json());
  if (!body.success)
    return c.json(
      { error: "接続キーとページ・データソースのIDを確認してください。" },
      400,
    );
  const prev = await c.env.DB.prepare(
    "SELECT lease_until FROM notion_connections WHERE user_id=?",
  )
    .bind(c.get("user").id)
    .first<{ lease_until: number }>();
  if (prev)
    return c.json(
      {
        error:
          "すでに接続済みです。接続先を変える場合は、同期完了後に解除してから設定してください。",
      },
      409,
    );
  const { token, rootPageId, taskSourceId, projectSourceId } = body.data,
    client = new NotionClient(token);
  try {
    await client.call(`/pages/${rootPageId}`);
    for (const [id, required] of [
      [
        taskSourceId,
        {
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
        },
      ],
      [projectSourceId, { 案件名: "title" }],
    ] as const) {
      const source = await client.call(`/data_sources/${id}`);
      for (const [name, type] of Object.entries(required))
        if (source.properties?.[name]?.type !== type)
          throw Error(
            `Notionの項目「${name}」を確認してください。専用のデータベースを指定してください。`,
          );
      const database = await client.call(
        `/databases/${source.parent?.database_id}`,
      );
      if (
        database.parent?.page_id?.replaceAll("-", "") !==
        rootPageId.replaceAll("-", "")
      )
        throw Error("指定したデータベースが専用ページ内にありません。");
    }
    const cipher = await encryptNotionToken(c.env, c.get("user").id, token);
    const summary = await client.call("/pages", "POST", {
      parent: { page_id: rootPageId },
      properties: {
        title: {
          title: [{ text: { content: "現在の優先事項（Now自動更新）" } }],
        },
      },
    });
    const blocks = await client.call(
      `/blocks/${summary.id}/children`,
      "PATCH",
      {
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: {
                    content:
                      "Nowのタスクを同期してから、現在の優先事項を更新します。",
                  },
                },
              ],
            },
          },
        ],
      },
    );
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM notion_task_links WHERE user_id=?").bind(
        c.get("user").id,
      ),
      c.env.DB.prepare(
        "INSERT INTO notion_connections(user_id,token_cipher,root_page_id,task_source_id,project_source_id,summary_page_id,summary_block_id) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        c.get("user").id,
        cipher,
        rootPageId,
        taskSourceId,
        projectSourceId,
        summary.id,
        blocks.results[0].id,
      ),
    ]);
    return c.json({ connected: true });
  } catch (e) {
    return c.json(
      {
        error:
          e instanceof Error ? e.message : "Notionに接続できませんでした。",
      },
      400,
    );
  }
});
notion.post("/disconnect", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT lease_until FROM notion_connections WHERE user_id=?",
  )
    .bind(c.get("user").id)
    .first<{ lease_until: number }>();
  if (row && row.lease_until > Date.now())
    return c.json({ error: "同期中です。完了してから解除してください。" }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM notion_connections WHERE user_id=?").bind(
      c.get("user").id,
    ),
    c.env.DB.prepare("DELETE FROM notion_task_links WHERE user_id=?").bind(
      c.get("user").id,
    ),
  ]);
  return c.json({ ok: true });
});
notion.post("/sync", async (c) => {
  if (
    !(await c.env.DB.prepare(
      "SELECT user_id FROM notion_connections WHERE user_id=?",
    )
      .bind(c.get("user").id)
      .first())
  )
    return c.json({ error: "Notionの接続設定が必要です。" }, 400);
  c.executionCtx.waitUntil(syncNotion(c.env, c.get("user").id, 6));
  return c.json({ accepted: true }, 202);
});
notion.post("/resolve", async (c) => {
  const value = z
    .object({ taskId: z.uuid(), side: z.enum(["now", "notion"]) })
    .safeParse(await c.req.json());
  if (!value.success)
    return c.json({ error: "選択内容を確認してください。" }, 400);
  const updated = await c.env.DB.prepare(
    "UPDATE notion_task_links SET resolution=?,conflict=NULL WHERE user_id=? AND task_id=? AND conflict IS NOT NULL RETURNING task_id",
  )
    .bind(value.data.side, c.get("user").id, value.data.taskId)
    .first();
  if (!updated)
    return c.json({ error: "対象の同時編集が見つかりません。" }, 404);
  return c.json({ ok: true });
});
export default notion;
