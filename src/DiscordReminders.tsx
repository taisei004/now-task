import { useEffect, useState } from "react";
import { api } from "./storage";
type State = {
  enabled: boolean | number;
  last_sent?: number;
  last_error?: string;
};
export default function DiscordReminders() {
  const [state, setState] = useState<State | null>(null),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = () => api<State>("/api/discord-reminders").then(setState);
  useEffect(() => {
    void load().catch(() => setMessage("通知設定を読み込めませんでした。"));
  }, []);
  const run = async (action: string) => {
    setBusy(true);
    setMessage("");
    const value = token;
    setToken("");
    try {
      await api(
        `/api/discord-reminders${action}`,
        action === "" ? { token: value } : {},
      );
      await load();
      setMessage(
        action === "/test"
          ? "kusanoにテスト送信しました。"
          : action === "/stop"
            ? "通知を停止し、保存したトークンを削除しました。"
            : "毎日9:00・13:00・18:00の通知を有効にしました。",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="notion-settings">
      <strong>Discord定時リマインド</strong>
      <p>毎日 9:00・13:00・18:00（日本時間）／kusano</p>
      <p>
        今すぐ着手する1件と理由、今日が期日のタスク、期限超過を送ります。チャンネルを閲覧できる人にタスク名が表示されます。
      </p>
      {state && (
        <>
          <p>{state.enabled ? "有効" : "未設定"}</p>
          {!!state.enabled && (
            <>
              <button disabled={busy} onClick={() => void run("/test")}>
                今の内容をテスト送信
              </button>
              <button disabled={busy} onClick={() => void run("/stop")}>
                通知を停止
              </button>
            </>
          )}
          <details>
            <summary>
              {state.enabled ? "Botトークンを更新" : "定時送信を設定"}
            </summary>
            <p>まずBotをサーバーに追加してください。</p>
            <a
              href="https://discord.com/oauth2/authorize?client_id=1561466054452969512&scope=bot%20applications.commands&permissions=3072&guild_id=1433011113599045704&disable_guild_select=true"
              target="_blank"
              rel="noreferrer"
            >
              Now Botを追加
            </a>
            <label>
              Botトークン
              <input
                aria-label="定時送信用Botトークン"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p>
              トークンは暗号化してCloudflareに保存します。通知停止時に削除します。チャットには貼らないでください。
            </p>
            <button disabled={busy || !token} onClick={() => void run("")}>
              保存して定時通知を有効にする
            </button>
          </details>
          {state.last_sent && (
            <p>
              最終送信{" "}
              {new Date(state.last_sent).toLocaleString("ja-JP", {
                timeZone: "Asia/Tokyo",
              })}
              （日本時間）
            </p>
          )}
          {state.last_error && <p role="alert">{state.last_error}</p>}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
