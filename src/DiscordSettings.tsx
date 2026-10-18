import { useEffect, useState } from "react";
import { api } from "./storage";
export default function DiscordSettings() {
  const [state, setState] = useState<{
      configured: boolean;
      linked: boolean;
    } | null>(null),
    [code, setCode] = useState<{ code: string; expiresAt: number } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [registered, setRegistered] = useState(false),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ configured: boolean; linked: boolean }>("/api/discord")
      .then(setState)
      .catch(() => setError("Discordの設定を取得できませんでした。"));
  }, []);
  useEffect(() => {
    if (!code) return;
    const interval = setInterval(() => {
      if (Date.now() >= code.expiresAt) {
        setCode(null);
        setError("連携コードの有効期限が切れました。再発行してください。");
        return;
      }
      void api<{
        configured: boolean;
        linked: boolean;
        canRegister?: boolean;
        tokenConfigured?: boolean;
      }>("/api/discord")
        .then((next) => {
          setState(next);
          if (next.linked) setCode(null);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [code]);
  const link = async () => {
    setBusy(true);
    setError("");
    try {
      setCode(await api("/api/discord/link", {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="discord-settings">
      <strong>Discord</strong>
      {!state && !error && <p>接続状態を確認中…</p>}
      {state && (
        <>
          <p>
            {state.linked
              ? "連携済み"
              : state.configured
                ? "未連携"
                : "Discordアプリの接続設定待ち"}
          </p>
          {state.configured && (
            <>
              <p>make A pro work space / kusano</p>
              <details className="discord-setup">
                <summary>初回のコマンド設定</summary>
                <p>
                  Bot
                  TokenはCloudflare経由でDiscordに送信し、コマンド登録にだけ使います。サーバーや端末には保存しません。
                </p>
                <label>
                  Bot Token
                  <input
                    type="password"
                    aria-label="Discord Bot Token"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <button
                  className="wide-secondary"
                  disabled={busy || !token.trim()}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    const value = token;
                    setToken("");
                    void api("/api/discord/register", { token: value })
                      .then(() => setRegistered(true))
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Discordコマンドを登録
                </button>
              </details>
              {registered && (
                <p role="status">
                  登録しました。kusano で /now panel
                  を実行するとボタンを設置できます。
                </p>
              )}
              <button
                className="wide-secondary"
                disabled={busy}
                onClick={() => void link()}
              >
                {busy
                  ? "発行中…"
                  : state.linked
                    ? "連携コードを再発行"
                    : "連携コードを発行"}
              </button>
              {code && (
                <>
                  <code className="discord-code">{code.code}</code>
                  <p>
                    10分以内に kusano で <code>/now link code:{code.code}</code>{" "}
                    を実行してください。コードを知る人がアカウントを連携できます。
                  </p>
                </>
              )}
              {state.linked && (
                <button
                  className="logout-button"
                  onClick={() => {
                    setBusy(true);
                    void api("/api/discord/unlink", {})
                      .then(() => {
                        setState({ ...state, linked: false });
                        setCode(null);
                      })
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                  disabled={busy}
                >
                  Discord連携を解除
                </button>
              )}
            </>
          )}
        </>
      )}
      {error && <p role="status">{error}</p>}
    </div>
  );
}
