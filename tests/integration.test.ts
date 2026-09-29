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
