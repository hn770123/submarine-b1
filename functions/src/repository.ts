/** Firestore transaction で席・配置・行動を確定し、本人専用ビューを返す repository。 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  Firestore,
  Timestamp,
  type Transaction,
  type DocumentReference,
} from "firebase-admin/firestore";
import { ROOM_CONFIG, GAME_CONFIG } from "../../src/shared/game-config.js";
import {
  createGame,
  generateBoard,
  resolveAction,
  validPlacement,
  type Action,
  type Board,
  type GameState,
  type Pose,
} from "../../src/shared/engine.js";
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
  placement?: Pose;
  knowledgeState: object;
  joinedAt: Timestamp;
  lastSeenAt: Timestamp;
}
interface Room extends PasscodeHash {
  roomCode: string;
  status: "waiting" | "placement" | "playing" | "finished" | "expired";
  version: number;
  rulesVersion: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;
  gameState: { board: Board } | GameState;
  history?: { turn: number; playerId: string; action: Action }[];
  turnPlayerId: string | null;
  turnNumber: number;
  winnerPlayerId: string | null;
}
/** 期限は TTL の非同期削除を待たず、API の処理時刻で検査する。 */
function checkExpiry(room: Room): void {
  if (room.expiresAt.toMillis() <= Date.now() || room.status === "expired")
    throw new ApiError(409, "ROOM_EXPIRED", "ルームの有効期限が切れています。");
}
/** 秘密値をコピーせず、許可済みの表示項目だけからレスポンスを組み立てる。 */
function view(room: Room, players: Player[], self: Player): RoomView {
  const result: RoomView = {
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
  // 配置前は共通盤面と本人の配置のみを公開し、相手の確定位置は返さない。
  if (room.status === "placement") {
    result.board = room.gameState.board;
    if (self.placement) result.placement = self.placement;
  }
  if (room.status === "playing" || room.status === "finished") {
    const state = room.gameState as GameState;
    result.game = {
      board: state.board,
      self: state.submarines[self.playerId],
      knowledge: state.knowledge[self.playerId],
      ownTorpedoes: state.torpedoes.filter((t) => t.owner === self.playerId),
      turnNumber: state.turnNumber,
      yourTurn:
        room.status === "playing" && state.turnPlayerId === self.playerId,
      winner:
        room.status !== "finished"
          ? null
          : state.winnerPlayerId === null
            ? "draw"
            : state.winnerPlayerId === self.playerId
              ? "self"
              : "opponent",
      history: (room.history ?? []).map((h) => ({
        turn: h.turn,
        action: h.playerId === self.playerId ? h.action : "OPPONENT_TURN",
      })),
    };
  }
  return result;
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
        history: [],
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
  /** 本人の配置だけを確定し、二人が揃った取引で先手と対戦状態を決める。 */
  async placement(code: string, token: string, pose: Pose): Promise<RoomView> {
    // 取引の再実行でも先手が変わらないよう、乱数は外側で一度だけ生成する。
    const firstSeat = randomBytes(1)[0] % 2 === 0 ? "host" : "guest";
    return this.db.runTransaction(async (tx) => {
      const { ref, room } = await this.readRoom(tx, code);
      const players = (await tx.get(ref.collection("players"))).docs.map(
        (d) => d.data() as Player,
      );
      const self = this.authenticate(players, token);
      if (self.placementReady) {
        if (
          self.placement?.x !== pose.x ||
          self.placement.y !== pose.y ||
          self.placement.direction !== pose.direction
        )
          throw new ApiError(
            409,
            "PLACEMENT_LOCKED",
            "配置はすでに確定しています。",
          );
        return view(room, players, self);
      }
      if (room.status !== "placement" || players.length !== 2)
        throw new ApiError(
          409,
          "NOT_PLACEMENT",
          "配置できる状態ではありません。",
        );
      if (!validPlacement(room.gameState.board, pose, self.seat))
        throw new ApiError(
          400,
          "INVALID_PLACEMENT",
          "配置域または海域を確認してください。",
        );
      const updatedSelf = { ...self, placementReady: true, placement: pose };
      const updatedPlayers = players.map((p) =>
        p.playerId === self.playerId ? updatedSelf : p,
      );
      const ready = updatedPlayers.every((p) => p.placementReady);
      const ordered = [...updatedPlayers].sort((a, b) =>
        a.seat === "host" ? -1 : b.seat === "host" ? 1 : 0,
      );
      const game = ready
        ? createGame(
            room.gameState.board.seed,
            Object.fromEntries(ordered.map((p) => [p.playerId, p.placement!])),
            ordered.find((p) => p.seat === firstSeat)!.playerId,
          )
        : null;
      const updated: Room = {
        ...room,
        status: ready ? "playing" : "placement",
        version: room.version + 1,
        updatedAt: Timestamp.now(),
        gameState: game ?? room.gameState,
        turnPlayerId: game?.turnPlayerId ?? null,
        turnNumber: game?.turnNumber ?? 0,
      };
      tx.update(ref.collection("players").doc(self.playerId), {
        placementReady: true,
        placement: pose,
      });
      tx.update(ref, {
        status: updated.status,
        version: updated.version,
        updatedAt: updated.updatedAt,
        gameState: updated.gameState,
        turnPlayerId: updated.turnPlayerId,
        turnNumber: updated.turnNumber,
      });
      return view(updated, updatedPlayers, updatedSelf);
    });
  }
  /** 行動 ID を room 内で一意に保存し、再送時は確定済みの本人ビューを返す。 */
  async action(
    code: string,
    token: string,
    actionId: string,
    expectedVersion: number,
    action: Action,
  ): Promise<RoomView> {
    return this.db.runTransaction(async (tx) => {
      const { ref, room } = await this.readRoom(tx, code);
      const players = (await tx.get(ref.collection("players"))).docs.map(
        (d) => d.data() as Player,
      );
      const self = this.authenticate(players, token);
      const actionRef = ref.collection("actions").doc(actionId);
      const previous = await tx.get(actionRef);
      if (previous.exists) {
        if (
          previous.get("playerId") !== self.playerId ||
          previous.get("actionType") !== action
        )
          throw new ApiError(
            409,
            "ACTION_ID_REUSED",
            "行動 ID が再利用されています。",
          );
        return previous.get("resultView") as RoomView;
      }
      if (room.status !== "playing")
        throw new ApiError(409, "NOT_PLAYING", "対戦中ではありません。");
      if (room.turnPlayerId !== self.playerId)
        throw new ApiError(403, "NOT_YOUR_TURN", "相手の手番です。");
      if (room.version !== expectedVersion)
        throw new ApiError(
          409,
          "STALE_VERSION",
          "状態を更新してから操作してください。",
        );
      let game: GameState;
      try {
        game = resolveAction(
          room.gameState as GameState,
          self.playerId,
          action,
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "INVALID_ACTION";
        if (["BLOCKED_MOVE", "NO_AMMO"].includes(code))
          throw new ApiError(
            400,
            code,
            code === "NO_AMMO"
              ? "魚雷が残っていません。"
              : "その方向には進めません。",
          );
        throw error;
      }
      const history = [
        ...(room.history ?? []),
        { turn: room.turnNumber, playerId: self.playerId, action },
      ].slice(-40);
      const updated: Room = {
        ...room,
        gameState: game,
        history,
        status: game.status,
        turnPlayerId: game.turnPlayerId,
        turnNumber: game.turnNumber,
        winnerPlayerId: game.winnerPlayerId,
        version: room.version + 1,
        updatedAt: Timestamp.now(),
      };
      const result = view(updated, players, self);
      tx.update(ref, {
        gameState: game,
        history,
        status: updated.status,
        turnPlayerId: updated.turnPlayerId,
        turnNumber: updated.turnNumber,
        winnerPlayerId: updated.winnerPlayerId,
        version: updated.version,
        updatedAt: updated.updatedAt,
      });
      tx.create(actionRef, {
        playerId: self.playerId,
        turnNumber: room.turnNumber,
        actionType: action,
        actionPayload: {},
        resultSummary: { version: updated.version, status: updated.status },
        resultView: result,
        createdAt: updated.updatedAt,
      });
      return result;
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
