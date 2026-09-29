/** ルーム作成・参加・待機・同じタブの再読み込み復帰を提供する画面。 */
import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { JoinedRoom, RoomView, Session } from "../../src/shared/api";
import "./style.css";
const SESSION_KEY = "submarine-session-v1";
/** 保存形式を検査し、壊れた保存データを token として扱わない。 */
function readSession(): Session | null {
  try {
    const data = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    return data &&
      /^[A-F0-9]{12}$/.test(data.roomCode) &&
      /^[A-Za-z0-9_-]{43}$/.test(data.token)
      ? data
      : null;
  } catch {
    return null;
  }
}
/** 同一オリジン API を呼び、エラー文言だけを UI に伝える。 */
async function request<T>(
  path: string,
  method = "GET",
  body?: object,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "通信に失敗しました。");
  return data;
}
/** 入力・通信中・相手待ちを区別し、二重送信を防ぐルーム UI。 */
function App() {
  const [session, setSession] = useState<Session | null>(readSession);
  const [view, setView] = useState<RoomView | null>(null);
  const [mode, setMode] = useState<"create" | "join">("create");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    /** 前の通信が終わってから次のポーリングを予約し、重複通信を避ける。 */
    async function poll() {
      try {
        const data = await request<RoomView>(
          `/rooms/${session!.roomCode}/state`,
          "GET",
          undefined,
          session!.token,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setView(data);
        setConnected(true);
        setError("");
      } catch (e) {
        if (controller.signal.aborted) return;
        setConnected(false);
        setError(e instanceof Error ? e.message : "通信に失敗しました。");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session]);
  /** 入力値を送信し、パスコードを消去してタブ限定の復帰情報を保存する。 */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const body = {
        displayName: String(data.get("displayName")),
        passcode: String(data.get("passcode")),
      };
      const code = String(data.get("code") ?? "")
        .trim()
        .toUpperCase();
      const result = await request<JoinedRoom>(
        mode === "create" ? "/rooms" : `/rooms/${code}/join`,
        "POST",
        body,
      );
      const next = { roomCode: result.roomCode, token: result.token };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      setSession(next);
      setView(result.view);
      setConnected(true);
      form.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  }
  /** サーバーで席を解放できた後に、ローカルの token を破棄する。 */
  async function leave() {
    if (!session || busy) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/rooms/${session.roomCode}/leave`,
        "POST",
        undefined,
        session.token,
      );
      forget();
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  }
  /** 期限切れ等で復帰できない場合に保存情報を明示的に破棄する。 */
  function forget() {
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
    setView(null);
    setError("");
    setConnected(false);
  }
  /** 秘密 token を含めず、共有用ルームコードだけをコピーする。 */
  async function copy() {
    try {
      await navigator.clipboard.writeText(session!.roomCode);
      setCopied(true);
    } catch {
      setError("コピーできませんでした。表示されたコードを共有してください。");
    }
  }
  return (
    <main>
      <p className="eyebrow">SUBMARINE / 01</p>
      <h1>深海戦術</h1>
      <p className="intro">見えない相手と、静かな駆け引き。</p>
      {session ? (
        <section aria-labelledby="room-heading">
          <h2 id="room-heading">
            {view?.status === "placement"
              ? "2人の参加が完了しました"
              : "相手の参加を待っています"}
          </h2>
          <p>ルームコード</p>
          <p className="code">{session.roomCode}</p>
          <button onClick={copy}>
            {copied ? "コピーしました" : "コードをコピー"}
          </button>
          <p role="status">
            {connected ? "● 接続中" : "△ 再接続中 — 表示が古い可能性があります"}
          </p>
          {view && (
            <>
              <ul className="players">
                {view.players.map((p) => (
                  <li key={p.seat}>
                    <span>{p.seat === "host" ? "ホスト" : "ゲスト"}</span>
                    <strong>{p.displayName}</strong>
                    {p.seat === view.self.seat ? "（あなた）" : ""}
                  </li>
                ))}
              </ul>
              <p>
                有効期限：{new Date(view.expiresAt).toLocaleString("ja-JP")}
              </p>
            </>
          )}
          {view?.status === "placement" && (
            <p className="notice">
              対戦の準備が整いました。初期配置と対戦操作は次の実装フェーズで追加します。
            </p>
          )}
          <button disabled={busy} onClick={leave}>
            ルームから退出
          </button>
          {!connected && (
            <button className="secondary" onClick={forget}>
              復帰情報を削除してトップへ
            </button>
          )}
        </section>
      ) : (
        <section aria-labelledby="entry-heading">
          <h2 id="entry-heading">対戦ルーム</h2>
          <div className="modes">
            <button
              aria-pressed={mode === "create"}
              onClick={() => setMode("create")}
              disabled={busy}
            >
              ルームを作成
            </button>
            <button
              aria-pressed={mode === "join"}
              onClick={() => setMode("join")}
              disabled={busy}
            >
              ルームに参加
            </button>
          </div>
          <form onSubmit={submit}>
            <label>
              表示名
              <input
                name="displayName"
                required
                maxLength={24}
                autoComplete="nickname"
                disabled={busy}
              />
            </label>
            {mode === "join" && (
              <label>
                ルームコード
                <input
                  name="code"
                  required
                  minLength={12}
                  maxLength={12}
                  pattern="[a-fA-F0-9]{12}"
                  autoCapitalize="characters"
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
            )}
            <label>
              パスコード
              <input
                name="passcode"
                aria-describedby="passcode-help"
                type="password"
                required
                minLength={6}
                maxLength={64}
                autoComplete={
                  mode === "create" ? "new-password" : "current-password"
                }
                disabled={busy}
              />
            </label>
            <p id="passcode-help" className="hint">
              6〜64文字。相手には別途共有してください。
            </p>
            <button className="primary" disabled={busy} type="submit">
              {busy
                ? "通信中…"
                : mode === "create"
                  ? "作成して待機"
                  : "参加する"}
            </button>
          </form>
          <p className="hint">
            同じタブで再読み込みすると復帰します。タブを閉じると復帰情報は失われます。
          </p>
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
