/** Firestore transaction で二席の予約と token 認証を一貫して行う repository。 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  Firestore,
  Timestamp,
  type Transaction,
  type DocumentReference,
} from "firebase-admin/firestore";
import { ROOM_CONFIG, GAME_CONFIG } from "../../src/shared/game-config.js";
import { generateBoard } from "../../src/shared/engine.js";
import type { RoomView, JoinedRoom } from "../../src/shared/api.js";
import {
  hashPasscode,
  verifyPasscode,
  newToken,
  tokenHash,
  equalHash,
  type PasscodeHash,
} from "./crypto.js";
import { ApiError } from "./errors.js";
interface Player {
  playerId: string;
  seat: "host" | "guest";
  displayName: string;
  tokenHash: string;
  placementReady: boolean;
  knowledgeState: object;
  joinedAt: Timestamp;
  lastSeenAt: Timestamp;
}
interface Room extends PasscodeHash {
  roomCode: string;
  status: "waiting" | "placement" | "expired";
  version: number;
  rulesVersion: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;
  gameState: object | null;
  turnPlayerId: null;
  turnNumber: number;
  winnerPlayerId: null;
}
/** 期限は TTL の非同期削除を待たず、API の処理時刻で検査する。 */
function checkExpiry(room: Room): void {
  if (room.expiresAt.toMillis() <= Date.now() || room.status === "expired")
    throw new ApiError(409, "ROOM_EXPIRED", "ルームの有効期限が切れています。");
}
/** 秘密値をコピーせず、許可済みの表示項目だけからレスポンスを組み立てる。 */
function view(room: Room, players: Player[], self: Player): RoomView {
  return {
    roomCode: room.roomCode,
    status: room.status,
    version: room.version,
    expiresAt: room.expiresAt.toMillis(),
    self: {
      playerId: self.playerId,
      seat: self.seat,
      displayName: self.displayName,
    },
    players: [...players]
      .sort((a, b) => (a.seat === "host" ? 0 : 1) - (b.seat === "host" ? 0 : 1))
      .map((p) => ({
        seat: p.seat,
        displayName: p.displayName,
        placementReady: p.placementReady,
      })),
  };
}
export class RoomRepository {
  /** 接続先を注入し、Emulator と本番で同じ処理を使用する。 */
  constructor(private db: Firestore) {}
  /** コードの参照と room を先に読み取る。 */
  private async readRoom(
    tx: Transaction,
    code: string,
  ): Promise<{ ref: DocumentReference; room: Room }> {
    const mapping = await tx.get(this.db.doc(`roomCodes/${code}`));
    if (!mapping.exists)
      throw new ApiError(404, "ROOM_NOT_FOUND", "ルームが見つかりません。");
    const ref = this.db.doc(`rooms/${mapping.get("roomId")}`);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists)
      throw new ApiError(404, "ROOM_NOT_FOUND", "ルームが見つかりません。");
    const room = snapshot.data() as Room;
    checkExpiry(room);
    return { ref, room };
  }
  /** ハッシュ一致した参加者のみ本人と認める。 */
  private authenticate(players: Player[], token: string): Player {
    const hashed = tokenHash(token);
    const self = players.find((p) => equalHash(p.tokenHash, hashed));
    if (!self)
      throw new ApiError(
        401,
        "INVALID_TOKEN",
        "再接続情報を確認してください。",
      );
    return self;
  }
  /** 短いコードを transaction で一意に予約してホストを登録する。 */
  async create(displayName: string, passcode: string): Promise<JoinedRoom> {
    const saved = await hashPasscode(passcode);
    const token = newToken();
    const roomId = randomUUID();
    const playerId = randomUUID();
    const now = Timestamp.now(),
      expiresAt = Timestamp.fromMillis(now.toMillis() + ROOM_CONFIG.ttlMs);
    const player: Player = {
      playerId,
      seat: "host",
      displayName,
      tokenHash: tokenHash(token),
      placementReady: false,
      knowledgeState: {},
      joinedAt: now,
      lastSeenAt: now,
    };
    const seed = randomBytes(4).readUInt32BE();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomBytes(6).toString("hex").toUpperCase();
      const room: Room = {
        ...saved,
        roomCode: code,
        status: "waiting",
        version: 1,
        rulesVersion: GAME_CONFIG.version,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        gameState: { board: generateBoard(seed) },
        turnPlayerId: null,
        turnNumber: 0,
        winnerPlayerId: null,
      };
      const created = await this.db.runTransaction(async (tx) => {
        const mapping = this.db.doc(`roomCodes/${code}`);
        if ((await tx.get(mapping)).exists) return false;
        tx.create(mapping, { roomId, expiresAt });
        const ref = this.db.doc(`rooms/${roomId}`);
        tx.create(ref, room);
        tx.create(ref.collection("players").doc(playerId), player);
        return true;
      });
      if (created)
        return { roomCode: code, token, view: view(room, [player], player) };
    }
    throw new ApiError(
      409,
      "CODE_COLLISION",
      "コードの生成を再試行してください。",
    );
  }
  /** パスコードを検証し、並行参加にも一席だけを割り当てる。 */
  async join(
    code: string,
    displayName: string,
    passcode: string,
    existingToken?: string,
  ): Promise<JoinedRoom> {
    // 復帰 token がある場合は追加席を作らず、既存の本人として処理する。
    if (existingToken)
      return {
        roomCode: code,
        token: existingToken,
        view: await this.state(code, existingToken),
      };
    const mapping = await this.db.doc(`roomCodes/${code}`).get();
    if (!mapping.exists)
      throw new ApiError(404, "ROOM_NOT_FOUND", "ルームが見つかりません。");
    const ref = this.db.doc(`rooms/${mapping.get("roomId")}`);
    const snapshot = await ref.get();
    if (!snapshot.exists)
      throw new ApiError(404, "ROOM_NOT_FOUND", "ルームが見つかりません。");
    const saved = snapshot.data() as Room;
    checkExpiry(saved);
    if (!(await verifyPasscode(passcode, saved)))
      throw new ApiError(403, "WRONG_PASSCODE", "パスコードが違います。");
    const token = newToken(),
      playerId = randomUUID(),
      now = Timestamp.now();
    const guest: Player = {
      playerId,
      seat: "guest",
      displayName,
      tokenHash: tokenHash(token),
      placementReady: false,
      knowledgeState: {},
      joinedAt: now,
      lastSeenAt: now,
    };
    const result = await this.db.runTransaction(async (tx) => {
      const { ref: currentRef, room } = await this.readRoom(tx, code);
      const players = (await tx.get(currentRef.collection("players"))).docs.map(
        (d) => d.data() as Player,
      );
      if (
        currentRef.path !== ref.path ||
        room.passcodeHash !== saved.passcodeHash
      )
        throw new ApiError(409, "ROOM_CHANGED", "ルームを再確認してください。");
      if (players.length >= 2 || room.status !== "waiting")
        throw new ApiError(409, "ROOM_FULL", "このルームは満員です。");
      const updated = {
        ...room,
        status: "placement" as const,
        version: room.version + 1,
        updatedAt: now,
      };
      tx.create(currentRef.collection("players").doc(playerId), guest);
      tx.update(currentRef, {
        status: updated.status,
        version: updated.version,
        updatedAt: now,
      });
      return view(updated, [...players, guest], guest);
    });
    return { roomCode: code, token, view: result };
  }
  /** transaction 内で整合する待機ビューだけを返す。 */
  async state(code: string, token: string): Promise<RoomView> {
    return this.db.runTransaction(async (tx) => {
      const { ref, room } = await this.readRoom(tx, code);
      const players = (await tx.get(ref.collection("players"))).docs.map(
        (d) => d.data() as Player,
      );
      const self = this.authenticate(players, token);
      return view(room, players, self);
    });
  }
  /** 配置前のゲスト退出は席を解放し、ホスト退出はルームを無効にする。 */
  async leave(code: string, token: string): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const { ref, room } = await this.readRoom(tx, code);
      const players = (await tx.get(ref.collection("players"))).docs.map(
        (d) => d.data() as Player,
      );
      const self = this.authenticate(players, token);
      if (
        !["waiting", "placement"].includes(room.status) ||
        players.some((p) => p.placementReady)
      )
        throw new ApiError(409, "CANNOT_LEAVE", "配置確定後は退出できません。");
      tx.delete(ref.collection("players").doc(self.playerId));
      tx.update(ref, {
        status: self.seat === "host" ? "expired" : "waiting",
        version: room.version + 1,
        updatedAt: Timestamp.now(),
      });
      if (self.seat === "host")
        tx.update(this.db.doc(`roomCodes/${code}`), {
          expiresAt: Timestamp.now(),
        });
    });
  }
  /** インスタンスを跨ぐ固定窓の試行数制限でパスコード総当たりを抑える。 */
  async rateLimit(key: string, limit: number): Promise<void> {
    const window = Math.floor(Date.now() / 60_000);
    const ref = this.db.doc(`rateLimits/${tokenHash(`${key}:${window}`)}`);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? Number(snap.get("count")) : 0;
      if (count >= limit)
        throw new ApiError(
          429,
          "RATE_LIMITED",
          "しばらく待ってから再試行してください。",
        );
      tx.set(ref, {
        count: count + 1,
        expiresAt: Timestamp.fromMillis((window + 2) * 60_000),
      });
    });
  }
}
