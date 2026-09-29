/** 保存済みの対戦を同じ規則で再現するための、バージョン付きゲーム設定。 */
export const GAME_CONFIG = Object.freeze({
  version: "1",
  width: 12,
  height: 15,
  initialHp: 100,
  torpedoes: 3,
  directDamage: 70,
  adjacentDamage: 25,
  sonarRange: 5,
  sonarOcclusion: true,
  torpedoRange: 18,
  warningRange: 3,
  reefRate: 0.12,
});
export const ROOM_CONFIG = Object.freeze({
  ttlMs: 24 * 60 * 60 * 1000,
  passcodeIterations: 600_000,
});
