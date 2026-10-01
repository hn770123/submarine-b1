/** ルーム参加から配置・対戦・同じタブの再読み込み復帰までを提供する画面。 */
import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { JoinedRoom, RoomView, Session } from "../../src/shared/api";
import type { Action } from "../../src/shared/engine";
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
  const [pose, setPose] = useState({
    x: 5,
    y: 1,
    direction: "S" as "N" | "E" | "S" | "W",
  });
  /** 遅れて届いたポーリング結果で新しい手番を巻き戻さない。 */
  function acceptView(next: RoomView) {
    setView((current) =>
      current?.roomCode === next.roomCode && current.version > next.version
        ? current
        : next,
    );
  }
  useEffect(() => {
    if (
      view?.status === "placement" &&
      view.self.seat === "guest" &&
      !view.placement
    )
      setPose((current) =>
        current.y < 12 ? { ...current, y: 13, direction: "N" } : current,
      );
  }, [view?.status, view?.self.seat, view?.placement]);
  /** 更新競合や通信失敗の後、認証済み状態をすぐに読み直す。 */
  async function refresh() {
    if (!session) return;
    const next = await request<RoomView>(
      `/rooms/${session.roomCode}/state`,
      "GET",
      undefined,
      session.token,
    );
    acceptView(next);
    setConnected(true);
  }
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
        acceptView(data);
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
      acceptView(result.view);
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
  /** 座標と向きを確定し、相手の確定をポーリングで待つ。 */
  async function place() {
    if (!session || busy || !connected) return;
    setBusy(true);
    setError("");
    try {
      acceptView(
        await request<RoomView>(
          `/rooms/${session.roomCode}/placement`,
          "POST",
          pose,
          session.token,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "配置に失敗しました。");
      try {
        await refresh();
      } catch {
        setConnected(false);
      }
    } finally {
      setBusy(false);
    }
  }
  /** 一回の操作に一つの ID を割り当て、完了後または競合後に表示を更新する。 */
  async function act(action: Action) {
    if (!session || !view?.game?.yourTurn || busy || !connected) return;
    setBusy(true);
    setError("");
    try {
      acceptView(
        await request<RoomView>(
          `/rooms/${session.roomCode}/actions`,
          "POST",
          {
            actionId: crypto.randomUUID(),
            expectedVersion: view.version,
            action,
          },
          session.token,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "行動に失敗しました。");
      try {
        await refresh();
      } catch {
        setConnected(false);
      }
    } finally {
      setBusy(false);
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
              ? "初期配置"
              : view?.status === "playing"
                ? "対戦中"
                : view?.status === "finished"
                  ? "対戦終了"
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
            <div className="notice">
              <p>
                配置域：
                {view.self.seat === "host" ? "上側 0〜2 行" : "下側 12〜14 行"}
                。相手の配置は表示されません。
              </p>
              {view.placement ? (
                <p>配置確定済み。相手を待っています。</p>
              ) : (
                <div className="placement-fields">
                  <label>
                    列 X
                    <input
                      type="number"
                      min="0"
                      max="11"
                      value={pose.x}
                      onChange={(e) =>
                        setPose({ ...pose, x: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    行 Y
                    <input
                      type="number"
                      min={view.self.seat === "host" ? "0" : "12"}
                      max={view.self.seat === "host" ? "2" : "14"}
                      value={pose.y}
                      onChange={(e) =>
                        setPose({ ...pose, y: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    向き
                    <select
                      value={pose.direction}
                      onChange={(e) =>
                        setPose({
                          ...pose,
                          direction: e.target.value as typeof pose.direction,
                        })
                      }
                    >
                      <option value="N">北</option>
                      <option value="E">東</option>
                      <option value="S">南</option>
                      <option value="W">西</option>
                    </select>
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !connected}
                    onClick={place}
                  >
                    配置を確定
                  </button>
                </div>
              )}
            </div>
          )}
          {view?.game && (
            <div className="game-info">
              <p role="status">
                {view.status === "finished"
                  ? view.game.winner === "self"
                    ? "勝利"
                    : view.game.winner === "draw"
                      ? "引き分け"
                      : "敗北"
                  : view.game.yourTurn
                    ? "あなたの手番"
                    : "相手の手番を待っています"}{" "}
                · 第{view.game.turnNumber}手
              </p>
              <p>
                自艦：({view.game.self.x}, {view.game.self.y}){" "}
                {view.game.self.direction} · HP {view.game.self.hp} · 魚雷{" "}
                {view.game.self.ammo}
              </p>
              <p>
                観測 {view.game.knowledge.observations.length}件 · 候補{" "}
                {view.game.knowledge.candidates.length}件 · 警報{" "}
                {view.game.knowledge.events.length}件
              </p>
              {view.status === "playing" && (
                <div className="actions">
                  {(
                    [
                      ["MOVE_FORWARD", "前進"],
                      ["TURN_LEFT", "左旋回"],
                      ["TURN_RIGHT", "右旋回"],
                      ["ACTIVE_SONAR", "ソナー"],
                      ["FIRE_TORPEDO", "魚雷発射"],
                    ] as [Action, string][]
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      disabled={busy || !connected || !view.game?.yourTurn}
                      onClick={() => act(action)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <h3>履歴</h3>
              <ol>
                {view.game.history.map((item) => (
                  <li key={item.turn}>
                    第{item.turn}手：
                    {item.action === "OPPONENT_TURN"
                      ? "相手の行動"
                      : item.action}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {(view?.status === "waiting" || view?.status === "placement") &&
            !view.players.some((p) => p.placementReady) && (
              <button disabled={busy} onClick={leave}>
                ルームから退出
              </button>
            )}
          {view?.status === "finished" && (
            <button onClick={forget}>トップへ戻る</button>
          )}
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
