import { useEffect, useState } from "react";
import { api } from "./storage";
type Config = {
  rootPageId: string;
  taskSourceId: string;
  projectSourceId: string;
};
type Status = {
  available: boolean;
  connected: boolean;
  rootUrl?: string;
  summaryUrl?: string;
  lastSync?: number | null;
  syncing?: boolean;
  error?: string | null;
  conflicts: { taskId: string; text: string; url: string }[];
};
function initialConfig() {
  try {
    const data = new URLSearchParams(location.hash.slice(1)).get("notion");
    return data ? JSON.stringify(JSON.parse(data), null, 2) : "";
  } catch {
    return "";
  }
}
export default function NotionSettings({
  syncTasks,
}: {
  syncTasks: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [config, setConfig] = useState(initialConfig),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () => api<Status>("/api/notion").then(setStatus);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api<Status>("/api/notion")
        .then((data) => {
          if (active) setStatus(data);
        })
        .catch(() => {
          if (active) setError("Notionの接続状態を確認できませんでした。");
        });
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await syncTasks();
      await api("/api/notion/sync", {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    let values: Config;
    try {
      values = JSON.parse(config);
    } catch {
      setError("接続情報を貼り付けてください。");
      return;
    }
    setBusy(true);
    setError("");
    const value = token;
    setToken("");
    try {
      await api("/api/notion/connect", { ...values, token: value });
      history.replaceState(null, "", location.pathname);
      await load();
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="notion-settings">
      <strong>Notion</strong>
      {!status && !error && <p>接続状態を確認中…</p>}
      {status && !status.connected && (
        <>
          <p>
            全体のタスクと案件をNotionにまとめます。接続後は2分ごとに同期します。
          </p>
          {!status.available && <p>接続機能の公開設定が必要です。</p>}
          <details open={!!config}>
            <summary>接続設定</summary>
            <label>
              接続情報
              <textarea
                aria-label="Notionの接続情報"
                rows={4}
                value={config}
                onChange={(e) => setConfig(e.target.value)}
                placeholder="専用ページの接続情報を貼り付け"
              />
            </label>
            <label>
              Notionの接続キー
              <input
                type="password"
                autoComplete="off"
                aria-label="Notionの接続キー"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p>
              専用ページへのアクセスを許可したキーを使います。キーは暗号化してCloudflareに保存し、このGoogleアカウントの同期に使います。
            </p>
            <button
              className="wide-secondary"
              disabled={
                busy || !status.available || !token.trim() || !config.trim()
              }
              onClick={() => void connect()}
            >
              {busy ? "接続中…" : "Notionに接続"}
            </button>
          </details>
        </>
      )}
      {status?.connected && (
        <>
          <p>
            {status.syncing
              ? "同期中…"
              : status.lastSync
                ? `最終同期 ${new Date(status.lastSync).toLocaleString("ja-JP")}`
                : "最初の同期を待っています"}
          </p>
          <div className="notion-links">
            <a href={status.rootUrl} target="_blank" rel="noreferrer">
              タスク全体を見る
            </a>
            <a href={status.summaryUrl} target="_blank" rel="noreferrer">
              優先事項の要約
            </a>
          </div>
          <button
            className="wide-secondary"
            disabled={busy || status.syncing}
            onClick={() => void run()}
          >
            今すぐNotionと同期
          </button>
          {status.error && <p role="status">{status.error}</p>}
          {status.conflicts.map((conflict) => (
            <div className="notion-conflict" key={conflict.taskId}>
              <p>{conflict.text}</p>
              <a href={conflict.url} target="_blank" rel="noreferrer">
                Notion側を確認
              </a>
              <div>
                {(["now", "notion"] as const).map((side) => (
                  <button
                    key={side}
                    disabled={busy || status.syncing}
                    onClick={() => {
                      setBusy(true);
                      void api("/api/notion/resolve", {
                        taskId: conflict.taskId,
                        side,
                      })
                        .then(() => run())
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {side === "now" ? "Nowの内容を使う" : "Notionの内容を使う"}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            className="logout-button"
            disabled={busy || status.syncing}
            onClick={() => {
              setBusy(true);
              void api("/api/notion/disconnect", {})
                .then(() => load())
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Notion接続を解除
          </button>
        </>
      )}
      {error && <p role="status">{error}</p>}
    </section>
  );
}
