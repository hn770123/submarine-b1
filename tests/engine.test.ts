/** エンジンの代表例・境界・再現性・入力不変性を検証する単体テスト。 */
import { describe, it, expect } from "vitest";
import { GAME_CONFIG } from "../src/shared/game-config.js";
import {
  createGame,
  resolveAction,
  generateBoard,
  rotate,
  isWater,
  forward,
  sonarVisible,
  expandCandidates,
  validPlacement,
  type GameState,
  type Direction,
} from "../src/shared/engine.js";
/** 岩礁のない状態を各テストへ独立して提供する。 */
function game(): GameState {
  const state = createGame(
    7,
    {
      host: { x: 2, y: 1, direction: "S" },
      guest: { x: 9, y: 13, direction: "N" },
    },
    "host",
  );
  state.board.reefs = [];
  return state;
}
describe("盤面と移動", () => {
  it("固定 seed の盤面と設定バージョンを再現する", () => {
    expect(generateBoard(42)).toEqual(generateBoard(42));
    expect(generateBoard(42)).not.toEqual(generateBoard(43));
    expect(game().rulesVersion).toBe(GAME_CONFIG.version);
  });
  it("全 seed で配置域を岩礁から保護する", () => {
    for (let seed = 0; seed < 50; seed++) {
      const b = generateBoard(seed);
      expect(b.reefs.every((p) => p.y >= 3 && p.y < 12)).toBe(true);
    }
  });
  it.each(["N", "E", "S", "W"] as Direction[])(
    "全方向 %s の左右旋回を戻せる",
    (direction) => {
      expect(rotate(rotate(direction, "left"), "right")).toBe(direction);
      let d = direction;
      for (let i = 0; i < 4; i++) d = rotate(d, "right");
      expect(d).toBe(direction);
    },
  );
  it("整数・盤外・岩礁を検査する", () => {
    const b = game().board;
    b.reefs = [{ x: 2, y: 2 }];
    for (const p of [
      { x: -1, y: 0 },
      { x: 12, y: 1 },
      { x: 0, y: 15 },
      { x: 0.5, y: 1 },
      { x: 2, y: 2 },
    ])
      expect(isWater(b, p)).toBe(false);
  });
  it("全方向の盤外前進を拒否する", () => {
    for (const [x, y, direction] of [
      [0, 0, "N"],
      [0, 0, "W"],
      [11, 14, "E"],
      [11, 14, "S"],
    ] as [number, number, Direction][]) {
      const s = game();
      Object.assign(s.submarines.host, { x, y, direction });
      expect(() => resolveAction(s, "host", "MOVE_FORWARD")).toThrow(
        "BLOCKED_MOVE",
      );
    }
  });
  it("岩礁と相手への衝突を拒否する", () => {
    const s = game();
    s.board.reefs = [{ x: 2, y: 2 }];
    expect(() => resolveAction(s, "host", "MOVE_FORWARD")).toThrow(
      "BLOCKED_MOVE",
    );
    s.board.reefs = [];
    Object.assign(s.submarines.guest, { x: 2, y: 2 });
    expect(() => resolveAction(s, "host", "MOVE_FORWARD")).toThrow(
      "BLOCKED_MOVE",
    );
  });
  it("席に応じた初期配置域を検査する", () => {
    const b = game().board;
    expect(validPlacement(b, { x: 0, y: 2, direction: "S" }, "host")).toBe(
      true,
    );
    expect(validPlacement(b, { x: 0, y: 3, direction: "S" }, "host")).toBe(
      false,
    );
    expect(validPlacement(b, { x: 0, y: 12, direction: "N" }, "guest")).toBe(
      true,
    );
    expect(() =>
      createGame(
        1,
        {
          host: { x: 0, y: 4, direction: "S" },
          guest: { x: 0, y: 12, direction: "N" },
        },
        "host",
      ),
    ).toThrow("INVALID_PLACEMENT");
  });
  it("手番・行動・規則の不正値を拒否する", () => {
    expect(() => resolveAction(game(), "guest", "TURN_LEFT")).toThrow(
      "NOT_YOUR_TURN",
    );
    const s = game();
    s.rulesVersion = "future";
    expect(() => resolveAction(s, "host", "TURN_LEFT")).toThrow(
      "UNSUPPORTED_RULES_VERSION",
    );
  });
  it("入力を変更せず前進一マスと手番交代を解決する", () => {
    const s = game(),
      snapshot = structuredClone(s);
    const result = resolveAction(s, "host", "MOVE_FORWARD");
    expect(s).toEqual(snapshot);
    expect(result.submarines.host.y).toBe(2);
    expect(result.turnPlayerId).toBe("guest");
    expect(result.turnNumber).toBe(2);
    expect(forward({ x: 0, y: 0, direction: "E" })).toEqual({
      x: 1,
      y: 0,
      direction: "E",
    });
  });
});
describe("ソナー・観測・候補領域", () => {
  it("範囲境界と直線の遮蔽を検査する", () => {
    const b = game().board;
    expect(sonarVisible(b, { x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
    expect(sonarVisible(b, { x: 0, y: 0 }, { x: 6, y: 0 })).toBe(false);
    b.reefs = [{ x: 1, y: 0 }];
    expect(sonarVisible(b, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
    expect(sonarVisible(b, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });
  it("ソナー捕捉で双方の観測を記録する", () => {
    const s = game();
    Object.assign(s.submarines.guest, { x: 2, y: 4 });
    const result = resolveAction(s, "host", "ACTIVE_SONAR");
    expect(result.knowledge.host.observations[0].kind).toBe("SONAR");
    expect(result.knowledge.host.candidates).toHaveLength(1);
    expect(result.knowledge.guest.observations[0].kind).toBe("PING");
  });
  it("遮蔽された敵は捕捉せず、発信者の位置は伝わる", () => {
    const s = game();
    Object.assign(s.submarines.guest, { x: 2, y: 4 });
    s.board.reefs = [{ x: 2, y: 2 }];
    const r = resolveAction(s, "host", "ACTIVE_SONAR");
    expect(r.knowledge.host.observations).toHaveLength(0);
    expect(r.knowledge.guest.observations).toHaveLength(1);
  });
  it("不検出なら可視域を候補から除く", () => {
    const s = game();
    s.knowledge.host.candidates = [
      { x: 2, y: 2, direction: "N" },
      { x: 9, y: 13, direction: "N" },
    ];
    const r = resolveAction(s, "host", "ACTIVE_SONAR");
    expect(r.knowledge.host.candidates).toEqual([
      { x: 9, y: 13, direction: "N" },
    ]);
  });
  it("敵の行動時だけ方向を含む可能領域を広げ、岩礁を除外する", () => {
    const s = game();
    const pose = { x: 2, y: 2, direction: "N" as const };
    s.knowledge.host.candidates = [pose];
    const r = resolveAction(s, "host", "TURN_LEFT");
    expect(r.knowledge.host.candidates).toEqual([pose]);
    s.board.reefs = [{ x: 2, y: 1 }];
    const expanded = expandCandidates(s.board, [pose]);
    expect(expanded).toHaveLength(3);
    expect(expanded.every((p) => p.y === 2)).toBe(true);
    expect(expandCandidates(s.board, [])).toEqual([]);
  });
});
describe("魚雷・ダメージ・勝敗", () => {
  it("既存魚雷のセルへ前進した場合は接触地点で直撃を適用する", () => {
    const s = game();
    s.torpedoes = [
      { id: "t", owner: "guest", x: 2, y: 2, direction: "E", remaining: 5 },
    ];
    const r = resolveAction(s, "host", "MOVE_FORWARD");
    expect(r.submarines.host.hp).toBe(30);
    expect(r.torpedoes).toHaveLength(0);
  });
  it("互いのセルを通過する魚雷も衝突する", () => {
    const s = game();
    s.torpedoes = [
      { id: "a", owner: "host", x: 4, y: 5, direction: "E", remaining: 5 },
      { id: "b", owner: "guest", x: 5, y: 5, direction: "W", remaining: 5 },
    ];
    const r = resolveAction(s, "host", "TURN_LEFT");
    expect(r.torpedoes).toHaveLength(0);
  });
  it("魚雷へ潜水艦の HP と残弾を誤ってコピーしない", () => {
    const r = resolveAction(game(), "host", "FIRE_TORPEDO");
    expect(Object.keys(r.torpedoes[0]).sort()).toEqual(
      ["id", "owner", "x", "y", "direction", "remaining"].sort(),
    );
  });

  it("発射で残弾を減らし、発射直後は一マス前に置く", () => {
    const r = resolveAction(game(), "host", "FIRE_TORPEDO");
    expect(r.submarines.host.ammo).toBe(2);
    expect(r.torpedoes[0]).toMatchObject({ x: 2, y: 2, owner: "host" });
    expect(r.knowledge.guest.events).toEqual([{ turn: 1, kind: "LAUNCH" }]);
    const next = resolveAction(r, "guest", "TURN_LEFT");
    expect(next.torpedoes[0].y).toBe(3);
  });
  it("残弾ゼロは拒否する", () => {
    const s = game();
    s.submarines.host.ammo = 0;
    expect(() => resolveAction(s, "host", "FIRE_TORPEDO")).toThrow("NO_AMMO");
  });
  it("直接命中は70、隣接爆発は25を適用する", () => {
    const s = game();
    Object.assign(s.submarines.guest, { x: 2, y: 2 });
    let r = resolveAction(s, "host", "FIRE_TORPEDO");
    expect(r.submarines.guest.hp).toBe(30);
    expect(r.submarines.host.hp).toBe(75);
    expect(r.torpedoes).toHaveLength(0);
    r.turnPlayerId = "host";
    r = resolveAction(r, "host", "FIRE_TORPEDO");
    expect(r.status).toBe("finished");
    expect(r.winnerPlayerId).toBe("host");
    expect(() => resolveAction(r, "guest", "TURN_LEFT")).toThrow(
      "NOT_YOUR_TURN",
    );
  });
  it("岩礁で爆発し、盤外は消滅する", () => {
    const s = game();
    s.board.reefs = [{ x: 2, y: 2 }];
    expect(resolveAction(s, "host", "FIRE_TORPEDO").submarines.host.hp).toBe(
      75,
    );
    Object.assign(s.submarines.host, { x: 0, y: 0, direction: "N" });
    expect(resolveAction(s, "host", "FIRE_TORPEDO").torpedoes).toHaveLength(0);
  });
  it("射程終了で爆発し、離れた潜水艦は無傷", () => {
    const s = game();
    s.torpedoes = [
      { id: "t", owner: "host", x: 6, y: 6, direction: "E", remaining: 1 },
    ];
    const r = resolveAction(s, "host", "TURN_RIGHT");
    expect(r.torpedoes).toHaveLength(0);
    expect(r.submarines.host.hp).toBe(100);
  });
  it("同一セルで衝突した魚雷の爆発を重複加算しない", () => {
    const s = game();
    Object.assign(s.submarines.guest, { x: 5, y: 5 });
    s.torpedoes = [
      { id: "a", owner: "host", x: 4, y: 5, direction: "E", remaining: 5 },
      { id: "b", owner: "guest", x: 6, y: 5, direction: "W", remaining: 5 },
    ];
    const r = resolveAction(s, "host", "TURN_LEFT");
    expect(r.submarines.guest.hp).toBe(30);
    expect(r.torpedoes).toHaveLength(0);
  });
  it("同時撃沈は引き分けにする", () => {
    const s = game();
    Object.assign(s.submarines.guest, { x: 2, y: 2, hp: 70 });
    s.submarines.host.hp = 25;
    const r = resolveAction(s, "host", "FIRE_TORPEDO");
    expect(r.status).toBe("finished");
    expect(r.winnerPlayerId).toBeNull();
    expect(Object.values(r.submarines).map((p) => p.hp)).toEqual([0, 0]);
  });
  it("敵魚雷の接近では方位だけを履歴に残す", () => {
    const s = game();
    s.torpedoes = [
      { id: "t", owner: "guest", x: 5, y: 1, direction: "W", remaining: 5 },
    ];
    const r = resolveAction(s, "host", "TURN_LEFT");
    expect(r.knowledge.host.events).toContainEqual({
      turn: 1,
      kind: "APPROACH",
      direction: "E",
    });
  });
  it("同じ行動列を繰り返すと常に同じ結果になる", () => {
    const actions = [
      "TURN_LEFT",
      "TURN_RIGHT",
      "FIRE_TORPEDO",
      "ACTIVE_SONAR",
    ] as const;
    const run = () =>
      actions.reduce((s, a) => resolveAction(s, s.turnPlayerId, a), game());
    expect(run()).toEqual(run());
  });
});
