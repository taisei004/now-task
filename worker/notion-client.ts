import type { Env } from "./auth";
export const NOTION_VERSION = "2026-03-11";
export type NotionPage = {
  id: string;
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, any>;
};
export class NotionClient {
  private lastCall = 0;
  constructor(private token: string) {}
  async call<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    if (!/^\/(data_sources|databases|pages|blocks)(\/|$)/.test(path))
      throw Error("Notionの操作先が不正です。");
    const wait = Math.max(0, 370 - (Date.now() - this.lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
    let response: Response;
    try {
      response = await fetch(`https://api.notion.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
        redirect: "error",
      });
    } catch {
      throw Error("Notionに接続できません。後でもう一度同期してください。");
    }
    if (!response.ok) {
      if (response.status === 401)
        throw Error("Notionの接続キーが無効です。接続設定を更新してください。");
      if (response.status === 403 || response.status === 404)
        throw Error(
          "Notionの対象ページへのアクセスを確認してください。ページの「接続」に連携を追加する必要があります。",
        );
      if (response.status === 429)
        throw Error(
          "Notionの利用上限に達しました。少し待って同期してください。",
        );
      throw Error(
        `Notionの処理に失敗しました（${response.status}）。対象データベースの項目を確認してください。`,
      );
    }
    return response.json() as Promise<T>;
  }
  async pages(source: string): Promise<NotionPage[]> {
    const result: NotionPage[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await this.call<{
        results: NotionPage[];
        has_more: boolean;
        next_cursor: string | null;
      }>(`/data_sources/${source}/query`, "POST", {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      result.push(...page.results);
      if (!page.has_more) return result;
      if (!page.next_cursor)
        throw Error("Notionの一覧を最後まで取得できませんでした。");
      cursor = page.next_cursor;
    }
    throw Error("Notionのタスクは最大5,000件まで同期できます。");
  }
}
const from64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const to64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
async function encryptionKey(env: Env) {
  if (!env.NOTION_ENCRYPTION_KEY)
    throw Error("Notion接続の暗号化設定が必要です。");
  const bytes = from64(env.NOTION_ENCRYPTION_KEY);
  if (bytes.length !== 32)
    throw Error("Notion接続の暗号化設定を確認してください。");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encryptNotionToken(
  env: Env,
  userId: string,
  token: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    await encryptionKey(env),
    new TextEncoder().encode(token),
  );
  return `${to64(iv)}.${to64(new Uint8Array(data))}`;
}
export async function decryptNotionToken(
  env: Env,
  userId: string,
  cipher: string,
) {
  const [iv, data] = cipher.split(".");
  try {
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: from64(iv),
          additionalData: new TextEncoder().encode(userId),
        },
        await encryptionKey(env),
        from64(data),
      ),
    );
  } catch {
    throw Error("Notion接続を読み込めません。接続設定を更新してください。");
  }
}
export const notionText = (property: any) =>
  ((property?.title ?? property?.rich_text ?? []) as any[])
    .map((t) => t.plain_text ?? t.text?.content ?? "")
    .join("");
export const richText = (value: string) => ({
  rich_text: value
    ? [{ type: "text", text: { content: value.slice(0, 2000) } }]
    : [],
});
