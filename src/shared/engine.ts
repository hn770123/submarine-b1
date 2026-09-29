/** 通信・時刻・外部乱数に依存しない潜水艦ゲームの権威エンジン。 */
import { GAME_CONFIG } from "./game-config.js";
export type Direction = "N" | "E" | "S" | "W";
export type Action =
  "MOVE_FORWARD" | "TURN_LEFT" | "TURN_RIGHT" | "ACTIVE_SONAR" | "FIRE_TORPEDO";
export interface Point {
  x: number;
  y: number;
}
export interface Pose extends Point {
  direction: Direction;
}
export interface Board {
  width: number;
  height: number;
  reefs: Point[];
  seed: number;
}
export interface Submarine extends Pose {
  hp: number;
  ammo: number;
}
export interface Torpedo extends Pose {
  id: string;
  owner: string;
  remaining: number;
}
export interface Observation {
  turn: number;
  kind: "SONAR" | "PING";
  pose: Pose;
}
export interface Knowledge {
  observations: Observation[];
  candidates: Pose[];
  events: {
    turn: number;
    kind: "LAUNCH" | "EXPLOSION" | "APPROACH";
    direction?: Direction;
  }[];
}
export interface GameState {
  rulesVersion: string;
  board: Board;
  submarines: Record<string, Submarine>;
  knowledge: Record<string, Knowledge>;
  torpedoes: Torpedo[];
  turnPlayerId: string;
  turnNumber: number;
  status: "playing" | "finished";
  winnerPlayerId: string | null;
}
const DIRECTIONS: Direction[] = ["N", "E", "S", "W"];
const DELTAS: Record<Direction, Point> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};
/** 同一座標かを判定する。 */
export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}
/** マンハッタン距離を計算する。 */
export function distance(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
/** 整数座標が盤内の海域にあるかを判定する。 */
export function isWater(board: Board, p: Point): boolean {
  return (
    Number.isInteger(p.x) &&
    Number.isInteger(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < board.width &&
    p.y < board.height &&
    !board.reefs.some((r) => samePoint(r, p))
  );
}
/** 向きに沿って一マス先の座標を返す。 */
export function forward(p: Pose): Pose {
  const d = DELTAS[p.direction];
  return { x: p.x + d.x, y: p.y + d.y, direction: p.direction };
}
/** 四方向の向きを循環させる。 */
export function rotate(
  direction: Direction,
  side: "left" | "right",
): Direction {
  return DIRECTIONS[
    (DIRECTIONS.indexOf(direction) + (side === "left" ? 3 : 1)) % 4
  ];
}
/** 固定 seed から接続された海域を生成し、上下三行の配置域を保護する。 */
export function generateBoard(seed: number): Board {
  const board: Board = {
    width: GAME_CONFIG.width,
    height: GAME_CONFIG.height,
    seed: seed >>> 0,
    reefs: [],
  };
  let state = seed >>> 0;
  for (let y = 3; y < board.height - 3; y++)
    for (let x = 0; x < board.width; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (state / 2 ** 32 >= GAME_CONFIG.reefRate) continue;
      board.reefs.push({ x, y });
      // 岩礁を置いて孤立した海域が生じる場合は、その岩礁だけ取り消す。
      const seen = new Set<string>(["0,0"]);
      const queue: Point[] = [{ x: 0, y: 0 }];
      for (let i = 0; i < queue.length; i++)
        for (const delta of Object.values(DELTAS)) {
          const p = { x: queue[i].x + delta.x, y: queue[i].y + delta.y };
          const key = `${p.x},${p.y}`;
          if (isWater(board, p) && !seen.has(key)) {
            seen.add(key);
            queue.push(p);
          }
        }
      if (seen.size !== board.width * board.height - board.reefs.length)
        board.reefs.pop();
    }
  return board;
}
/** 海域と座席別の配置範囲を検査する。 */
export function validPlacement(
  board: Board,
  pose: Pose,
  seat: "host" | "guest",
): boolean {
  return (
    DIRECTIONS.includes(pose.direction) &&
    isWater(board, pose) &&
    (seat === "host" ? pose.y < 3 : pose.y >= board.height - 3)
  );
}
/** 端点間の supercover を調べ、角をかすめる岩礁もソナー遮蔽として扱う。 */
export function sonarVisible(board: Board, from: Point, to: Point): boolean {
  if (!isWater(board, to) || distance(from, to) > GAME_CONFIG.sonarRange)
    return false;
  if (!GAME_CONFIG.sonarOcclusion) return true;
  const dx = to.x - from.x,
    dy = to.y - from.y,
    nx = Math.abs(dx),
    ny = Math.abs(dy);
  const sx = Math.sign(dx),
    sy = Math.sign(dy);
  let x = from.x,
    y = from.y,
    ix = 0,
    iy = 0;
  while (ix < nx || iy < ny) {
    const comparison = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (comparison === 0) {
      if (
        !isWater(board, { x: x + sx, y }) ||
        !isWater(board, { x, y: y + sy })
      )
        return false;
      x += sx;
      y += sy;
      ix++;
      iy++;
    } else if (comparison < 0) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    if (!isWater(board, { x, y })) return false;
  }
  return true;
}
/** 不明な相手の一行動について、停止・前進・左右旋回の可能性を展開する。 */
export function expandCandidates(board: Board, candidates: Pose[]): Pose[] {
  const result = new Map<string, Pose>();
  for (const pose of candidates) {
    const options = [
      pose,
      { ...pose, direction: rotate(pose.direction, "left") },
      { ...pose, direction: rotate(pose.direction, "right") },
      forward(pose),
    ];
    for (const next of options)
      if (isWater(board, next))
        result.set(`${next.x},${next.y},${next.direction}`, {
          x: next.x,
          y: next.y,
          direction: next.direction,
        });
  }
  return [...result.values()];
}
/** 配置済みの二隻から初期対戦状態を作り、未観測の候補は相手の配置域に限定する。 */
export function createGame(
  seed: number,
  placements: Record<string, Pose>,
  firstPlayerId: string,
): GameState {
  const ids = Object.keys(placements);
  const board = generateBoard(seed);
  if (ids.length !== 2 || !ids.includes(firstPlayerId))
    throw new Error("INVALID_PLAYERS");
  const submarines: Record<string, Submarine> = {};
  const knowledge: Record<string, Knowledge> = {};
  ids.forEach((id, index) => {
    if (!validPlacement(board, placements[id], index === 0 ? "host" : "guest"))
      throw new Error("INVALID_PLACEMENT");
    submarines[id] = {
      ...placements[id],
      hp: GAME_CONFIG.initialHp,
      ammo: GAME_CONFIG.torpedoes,
    };
    const candidates: Pose[] = [];
    for (let y = 0; y < board.height; y++)
      for (let x = 0; x < board.width; x++)
        for (const direction of DIRECTIONS) {
          const p = { x, y, direction };
          if (validPlacement(board, p, index === 0 ? "guest" : "host"))
            candidates.push(p);
        }
    knowledge[id] = { observations: [], candidates, events: [] };
  });
  return {
    rulesVersion: GAME_CONFIG.version,
    board,
    submarines,
    knowledge,
    torpedoes: [],
    turnPlayerId: firstPlayerId,
    turnNumber: 1,
    status: "playing",
    winnerPlayerId: null,
  };
}
/** 正確に観測した位置と向きを履歴へ保存する。 */
function observe(
  state: GameState,
  observer: string,
  target: string,
  kind: Observation["kind"],
): void {
  const { x, y, direction } = state.submarines[target];
  const pose = { x, y, direction };
  state.knowledge[observer].observations.push({
    turn: state.turnNumber,
    kind,
    pose,
  });
  state.knowledge[observer].candidates = [pose];
}
/** 接近警報に用いる、観測者から見た主要な方位を返す。 */
function bearing(from: Point, to: Point): Direction {
  return Math.abs(to.x - from.x) > Math.abs(to.y - from.y)
    ? to.x > from.x
      ? "E"
      : "W"
    : to.y > from.y
      ? "S"
      : "N";
}
/** 一行動を純粋に解決し、既存魚雷の同時更新・被害集計の後に勝敗を決める。 */
export function resolveAction(
  input: GameState,
  playerId: string,
  action: Action,
): GameState {
  if (input.rulesVersion !== GAME_CONFIG.version)
    throw new Error("UNSUPPORTED_RULES_VERSION");
  if (input.status !== "playing" || input.turnPlayerId !== playerId)
    throw new Error("NOT_YOUR_TURN");
  if (
    ![
      "MOVE_FORWARD",
      "TURN_LEFT",
      "TURN_RIGHT",
      "ACTIVE_SONAR",
      "FIRE_TORPEDO",
    ].includes(action)
  )
    throw new Error("INVALID_ACTION");
  const state = structuredClone(input);
  const ids = Object.keys(state.submarines);
  const enemy = ids.find((id) => id !== playerId)!;
  const sub = state.submarines[playerId];
  if (action === "MOVE_FORWARD") {
    const next = forward(sub);
    if (!isWater(state.board, next) || samePoint(next, state.submarines[enemy]))
      throw new Error("BLOCKED_MOVE");
    sub.x = next.x;
    sub.y = next.y;
  } else if (action === "TURN_LEFT" || action === "TURN_RIGHT")
    sub.direction = rotate(
      sub.direction,
      action === "TURN_LEFT" ? "left" : "right",
    );
  // 相手の実際の行動種別は漏らさず、あらゆる合法行動の可能性を展開する。
  state.knowledge[enemy].candidates = expandCandidates(
    state.board,
    state.knowledge[enemy].candidates,
  );
  if (action === "ACTIVE_SONAR") {
    observe(state, enemy, playerId, "PING");
    if (sonarVisible(state.board, sub, state.submarines[enemy]))
      observe(state, playerId, enemy, "SONAR");
    else
      state.knowledge[playerId].candidates = state.knowledge[
        playerId
      ].candidates.filter((p) => !sonarVisible(state.board, sub, p));
  }
  if (action === "FIRE_TORPEDO" && sub.ammo <= 0) throw new Error("NO_AMMO");
  const fresh: Torpedo[] =
    action === "FIRE_TORPEDO"
      ? [
          {
            id: `${state.turnNumber}:${playerId}`,
            owner: playerId,
            ...forward(sub),
            remaining: GAME_CONFIG.torpedoRange,
          },
        ]
      : [];
  if (fresh.length) {
    sub.ammo--;
    state.knowledge[enemy].events.push({
      turn: state.turnNumber,
      kind: "LAUNCH",
    });
  }
  // 移動した潜水艦が既存魚雷に接触した場合は、その地点で先に爆発する。
  const contact = state.torpedoes.filter((t) =>
    ids.some((id) => samePoint(t, state.submarines[id])),
  );
  const previous = state.torpedoes.filter((t) => !contact.includes(t));
  const moving = [
    ...previous.map((t) => ({
      ...t,
      ...forward(t),
      remaining: t.remaining - 1,
    })),
    ...fresh,
  ];
  const explosions: Point[] = [...contact];
  const survivors: Torpedo[] = [];
  moving.forEach((t, index) => {
    if (!isWater(state.board, t)) {
      if (
        t.x >= 0 &&
        t.y >= 0 &&
        t.x < state.board.width &&
        t.y < state.board.height
      )
        explosions.push(t);
      return;
    }
    const before = index < previous.length ? previous[index] : null;
    const hit = ids.some((id) => samePoint(t, state.submarines[id]));
    const collision = moving.some(
      (other, j) =>
        j !== index &&
        (samePoint(other, t) ||
          (before !== null &&
            j < previous.length &&
            samePoint(t, previous[j]) &&
            samePoint(other, before))),
    );
    if (hit || collision || t.remaining <= 0) explosions.push(t);
    else survivors.push(t);
  });
  // 同じ地点の同時爆発は一回にまとめる。複数地点の被害は同時に加算する。
  const unique = [
    ...new Map(explosions.map((p) => [`${p.x},${p.y}`, p])).values(),
  ];
  for (const id of ids) {
    const target = state.submarines[id];
    let damage = 0;
    for (const p of unique) {
      const d = distance(target, p);
      damage +=
        d === 0
          ? GAME_CONFIG.directDamage
          : d === 1
            ? GAME_CONFIG.adjacentDamage
            : 0;
    }
    target.hp = Math.max(0, target.hp - damage);
    if (unique.length)
      state.knowledge[id].events.push({
        turn: state.turnNumber,
        kind: "EXPLOSION",
      });
    for (const t of survivors)
      if (t.owner !== id && distance(target, t) <= GAME_CONFIG.warningRange)
        state.knowledge[id].events.push({
          turn: state.turnNumber,
          kind: "APPROACH",
          direction: bearing(target, t),
        });
  }
  state.torpedoes = survivors;
  const alive = ids.filter((id) => state.submarines[id].hp > 0);
  if (alive.length < 2) {
    state.status = "finished";
    state.winnerPlayerId = alive[0] ?? null;
  }
  state.turnPlayerId = enemy;
  state.turnNumber++;
  return state;
}
