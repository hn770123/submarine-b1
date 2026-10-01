/** Firestore Emulator を使用し、実際の API と transaction の認証・競合を検証する。 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Server } from "node:http";
import { createApp } from "../functions/src/app.js";
import { RoomRepository } from "../functions/src/repository.js";
import type { JoinedRoom } from "../src/shared/api.js";
if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error(
    "Firestore Emulator が必要です。npm run verify:emulators を使用してください。",
  );
const admin = initializeApp({ projectId: "demo-submarine" }, "integration");
const db = getFirestore(admin);
let server: Server, base: string;
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = createApp(new RoomRepository(db)).listen(0, "127.0.0.1", () =>
      resolve(s),
    );
  });
  const address = server.address();
  if (typeof address === "object" && address)
    base = `http://127.0.0.1:${address.port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.terminate();
  await deleteApp(admin);
});
/** JSON を実 API へ送り、認証が必要な場合だけ token をヘッダーに載せる。 */
async function call(
  path: string,
  body?: object,
  token?: string,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: response.status === 204 ? null : await response.json(),
  };
}
/** 独立したルームを各検証用に作成する。 */
async function create(): Promise<JoinedRoom> {
  const r = await call("/rooms", {
    displayName: "ホスト",
    passcode: "secret12",
  });
  expect(r.status).toBe(201);
  return r.data;
}
describe("ルーム API", () => {
  it("Hosting rewrite の配信ホストを扱い、異なる Origin を拒否する", async () => {
    const same = await fetch(base + "/health", {
      headers: {
        Origin: "https://example.test",
        "X-Forwarded-Host": "example.test",
      },
    });
    expect(same.status).toBe(200);
    const foreign = await fetch(base + "/health", {
      headers: {
        Origin: "https://evil.test",
        "X-Forwarded-Host": "example.test",
      },
    });
    expect(foreign.status).toBe(403);
    const invalid = await fetch(base + "/health", {
      headers: { Origin: "null" },
    });
    expect(invalid.status).toBe(403);
  });

  it("health は秘密情報を持たない", async () => {
    expect((await call("/health")).data).toEqual({ status: "ok" });
  });
  it("ホストとゲストが参加・復帰でき、第三者を拒否する", async () => {
    const host = await create();
    const guest = await call(`/rooms/${host.roomCode}/join`, {
      displayName: "ゲスト",
      passcode: "secret12",
    });
    expect(guest.status).toBe(200);
    expect(guest.data.view.status).toBe("placement");
    const full = await call(`/rooms/${host.roomCode}/join`, {
      displayName: "三人目",
      passcode: "secret12",
    });
    expect(full.status).toBe(409);
    expect(full.data.code).toBe("ROOM_FULL");
    const state = await call(
      `/rooms/${host.roomCode}/state`,
      undefined,
      host.token,
    );
    expect(state.data.players).toHaveLength(2);
    expect(state.data.self.seat).toBe("host");
    const saved = JSON.stringify(state.data);
    for (const secret of [
      "tokenHash",
      "passcodeHash",
      "passcodeSalt",
      "gameState",
      "knowledgeState",
      guest.data.token,
    ])
      expect(saved).not.toContain(secret);
    expect((await call(`/rooms/${host.roomCode}/state`)).status).toBe(401);
    expect(
      (await call(`/rooms/${host.roomCode}/state`, undefined, "a".repeat(43)))
        .status,
    ).toBe(401);
  });
  it("誤パスコード、存在しないコード、入力改ざんを拒否する", async () => {
    const host = await create();
    const wrong = await call(`/rooms/${host.roomCode}/join`, {
      displayName: "ゲスト",
      passcode: "wrong12",
    });
    expect(wrong.status).toBe(403);
    expect(wrong.data).toMatchObject({
      code: "WRONG_PASSCODE",
      requestId: expect.any(String),
    });
    expect(
      (await call("/rooms/FFFFFFFFFFFF/state", undefined, host.token)).status,
    ).toBe(404);
    expect(
      (await call("/rooms", { displayName: "", passcode: "x" })).status,
    ).toBe(400);
    expect(
      (
        await call("/rooms", {
          displayName: "攻撃者",
          passcode: "secret12",
          status: "placement",
        })
      ).status,
    ).toBe(400);
  });
  it("token 付き重複参加は同じ本人に復帰し、席数と version を増やさない", async () => {
    const host = await create();
    const joined = await call(`/rooms/${host.roomCode}/join`, {
      displayName: "ゲスト",
      passcode: "secret12",
    });
    const repeat = await call(
      `/rooms/${host.roomCode}/join`,
      { displayName: "ゲスト", passcode: "secret12" },
      joined.data.token,
    );
    expect(repeat.status).toBe(200);
    expect(repeat.data).toEqual(joined.data);
  });
  it("並行参加の transaction 競合でも一席だけが成功する", async () => {
    const host = await create();
    const responses = await Promise.all(
      ["A", "B"].map((displayName) =>
        call(`/rooms/${host.roomCode}/join`, {
          displayName,
          passcode: "secret12",
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const state = await call(
      `/rooms/${host.roomCode}/state`,
      undefined,
      host.token,
    );
    expect(state.data.version).toBe(2);
    expect(state.data.players).toHaveLength(2);
  });
  it("TTL 削除前でも期限切れルームを拒否する", async () => {
    const host = await create();
    const mapping = await db.doc(`roomCodes/${host.roomCode}`).get();
    await db
      .doc(`rooms/${mapping.get("roomId")}`)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
    expect(
      (await call(`/rooms/${host.roomCode}/state`, undefined, host.token)).data
        .code,
    ).toBe("ROOM_EXPIRED");
    expect(
      (
        await call(`/rooms/${host.roomCode}/join`, {
          displayName: "ゲスト",
          passcode: "secret12",
        })
      ).data.code,
    ).toBe("ROOM_EXPIRED");
  });
  it("別ルームの token は利用できない", async () => {
    const a = await create(),
      b = await create();
    expect(
      (await call(`/rooms/${a.roomCode}/state`, undefined, b.token)).status,
    ).toBe(401);
  });
  it("ゲスト退出で席を解放し、失効 token を拒否する", async () => {
    const host = await create();
    const guest = await call(`/rooms/${host.roomCode}/join`, {
      displayName: "ゲスト",
      passcode: "secret12",
    });
    expect(
      (await call(`/rooms/${host.roomCode}/leave`, {}, guest.data.token))
        .status,
    ).toBe(204);
    expect(
      (await call(`/rooms/${host.roomCode}/state`, undefined, guest.data.token))
        .status,
    ).toBe(401);
    expect(
      (await call(`/rooms/${host.roomCode}/state`, undefined, host.token)).data
        .status,
    ).toBe("waiting");
  });
  it("条件付き GET とホスト退出を処理する", async () => {
    const host = await create();
    const response = await fetch(`${base}/rooms/${host.roomCode}/state`, {
      headers: {
        Authorization: `Bearer ${host.token}`,
        "If-None-Match": '"1"',
      },
    });
    expect(response.status).toBe(304);
    expect(
      (await call(`/rooms/${host.roomCode}/leave`, {}, host.token)).status,
    ).toBe(204);
    expect(
      (await call(`/rooms/${host.roomCode}/state`, undefined, host.token)).data
        .code,
    ).toBe("ROOM_EXPIRED");
  });
  it("共有レート制限が複数 repository に跨って適用される", async () => {
    const key = `test:${crypto.randomUUID()}`;
    await new RoomRepository(db).rateLimit(key, 1);
    await expect(
      new RoomRepository(db).rateLimit(key, 1),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe("対戦進行 API", () => {
  /** 二席を作り、互いに離れた配置で対戦を開始する。 */
  async function started() {
    const host = await create();
    const joined = await call(`/rooms/${host.roomCode}/join`, {
      displayName: "ゲスト",
      passcode: "secret12",
    });
    const guest = joined.data as JoinedRoom;
    const path = `/rooms/${host.roomCode}`;
    const first = await call(
      `${path}/placement`,
      { x: 2, y: 1, direction: "S" },
      host.token,
    );
    expect(first.status).toBe(200);
    expect(first.data.status).toBe("placement");
    const hidden = JSON.stringify(
      await call(`${path}/state`, undefined, guest.token),
    );
    expect(hidden).not.toContain('"placement":{"x":2');
    const second = await call(
      `${path}/placement`,
      { x: 9, y: 13, direction: "N" },
      guest.token,
    );
    expect(second.status).toBe(200);
    expect(second.data.status).toBe("playing");
    return { host, guest, path };
  }
  it("配置域を検証し、敵の配置を伏せて先手を決める", async () => {
    const { host, guest, path } = await started();
    const repeated = await call(
      `${path}/placement`,
      { x: 2, y: 1, direction: "S" },
      host.token,
    );
    expect(repeated.status).toBe(200);
    const hostState = await call(`${path}/state`, undefined, host.token);
    const guestState = await call(`${path}/state`, undefined, guest.token);
    expect(
      [hostState.data.game.yourTurn, guestState.data.game.yourTurn].filter(
        Boolean,
      ),
    ).toHaveLength(1);
    expect(hostState.data.game.self).toMatchObject({ x: 2, y: 1 });
    expect(guestState.data.game.self).toMatchObject({ x: 9, y: 13 });
    expect(repeated.data.version).toBe(hostState.data.version);
    for (const state of [hostState, guestState]) {
      expect(state.data.game).not.toHaveProperty("submarines");
      expect(state.data.game).not.toHaveProperty("torpedoes");
      expect(state.data.game).not.toHaveProperty("gameState");
      expect(state.data).not.toHaveProperty("placement");
    }
    expect(
      (
        await call(
          `${path}/placement`,
          { x: 0, y: 0, direction: "N" },
          host.token,
        )
      ).data.code,
    ).toBe("PLACEMENT_LOCKED");
  });
  it("二重送信・古い version・複数タブの競合を直列化する", async () => {
    const { host, guest, path } = await started();
    const h = await call(`${path}/state`, undefined, host.token);
    const actor = h.data.game.yourTurn ? host : guest;
    const other = actor === host ? guest : host;
    const version = h.data.version;
    const actionId = crypto.randomUUID();
    const body = { actionId, expectedVersion: version, action: "TURN_LEFT" };
    const results = await Promise.all([
      call(`${path}/actions`, body, actor.token),
      call(`${path}/actions`, body, actor.token),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].data).toEqual(results[1].data);
    expect(results[0].data.version).toBe(version + 1);
    expect(
      (
        await call(
          `${path}/actions`,
          { ...body, action: "TURN_RIGHT" },
          actor.token,
        )
      ).data.code,
    ).toBe("ACTION_ID_REUSED");
    const next = await call(`${path}/state`, undefined, other.token);
    expect(next.data.game.yourTurn).toBe(true);
    const stale = await call(
      `${path}/actions`,
      {
        actionId: crypto.randomUUID(),
        expectedVersion: version,
        action: "TURN_RIGHT",
      },
      other.token,
    );
    expect(stale.data.code).toBe("STALE_VERSION");
    const concurrent = await Promise.all(
      ["TURN_LEFT", "TURN_RIGHT"].map((action) =>
        call(
          `${path}/actions`,
          {
            actionId: crypto.randomUUID(),
            expectedVersion: next.data.version,
            action,
          },
          other.token,
        ),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 403]);
    const latest = await call(`${path}/state`, undefined, host.token);
    expect(latest.data.version).toBe(version + 2);
    expect(latest.data.game.history).toHaveLength(2);
    expect(
      latest.data.game.history.some(
        (item: { action: string }) => item.action === "OPPONENT_TURN",
      ),
    ).toBe(true);
  }, 20_000);
});
