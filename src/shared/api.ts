/** API が返す待機ビュー。権威状態・認証秘密値を含めない共有型。 */
export interface RoomView {
  roomCode: string;
  status: "waiting" | "placement" | "expired";
  version: number;
  expiresAt: number;
  self: { playerId: string; seat: "host" | "guest"; displayName: string };
  players: {
    seat: "host" | "guest";
    displayName: string;
    placementReady: boolean;
  }[];
}
export interface Session {
  roomCode: string;
  token: string;
}
export interface JoinedRoom extends Session {
  view: RoomView;
}
