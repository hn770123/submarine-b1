/** パスコードの導出と再接続 token の発行・比較を担当する暗号処理。 */
import { randomBytes, createHash, pbkdf2, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ROOM_CONFIG } from "../../src/shared/game-config.js";
const derive = promisify(pbkdf2);
export interface PasscodeHash {
  passcodeHash: string;
  passcodeSalt: string;
  passcodeIterations: number;
}
/** 256 bit の再接続用秘密値を発行する。 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
/** 保存用の token hash を生成する。 */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** 長さの違う入力も安全に拒否し、一定時間比較する。 */
export function equalHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"),
    y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
/** ランダム salt と PBKDF2-SHA256 でパスコードを導出する。 */
export async function hashPasscode(passcode: string): Promise<PasscodeHash> {
  const passcodeSalt = randomBytes(16).toString("hex");
  const passcodeIterations = ROOM_CONFIG.passcodeIterations;
  const hash = await derive(
    passcode,
    passcodeSalt,
    passcodeIterations,
    32,
    "sha256",
  );
  return {
    passcodeHash: hash.toString("hex"),
    passcodeSalt,
    passcodeIterations,
  };
}
/** 保存済みの反復回数で導出し直し、パスコードの一致を確認する。 */
export async function verifyPasscode(
  passcode: string,
  saved: PasscodeHash,
): Promise<boolean> {
  const hash = await derive(
    passcode,
    saved.passcodeSalt,
    saved.passcodeIterations,
    32,
    "sha256",
  );
  return equalHash(hash.toString("hex"), saved.passcodeHash);
}
