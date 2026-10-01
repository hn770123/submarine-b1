/** API が返す本人専用ビュー。敵の権威状態・認証秘密値を含めない共有型。 */
import type {
  Action,
  Board,
  Knowledge,
  Pose,
  Submarine,
  Torpedo,
} from "./engine.js";

export interface GameView {
  board: Board;
  self: Submarine;
  knowledge: Knowledge;
  ownTorpedoes: Torpedo[];
  turnNumber: number;
  yourTurn: boolean;
  winner: "self" | "opponent" | "draw" | null;
  history: { turn: number; action: Action | "OPPONENT_TURN" }[];
}
export interface RoomView {
  roomCode: string;
  status: "waiting" | "placement" | "playing" | "finished" | "expired";
  version: number;
  expiresAt: number;
  self: { playerId: string; seat: "host" | "guest"; displayName: string };
  players: {
    seat: "host" | "guest";
    displayName: string;
    placementReady: boolean;
  }[];
  board?: Board;
  placement?: Pose;
  game?: GameView;
}
export interface Session {
  roomCode: string;
  token: string;
}
export interface JoinedRoom extends Session {
  view: RoomView;
}
