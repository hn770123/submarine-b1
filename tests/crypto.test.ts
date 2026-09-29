/** 秘密値が平文保存されず、不正なパスコードと token が拒否されることを検証。 */
import { it, expect } from "vitest";
import {
  hashPasscode,
  verifyPasscode,
  tokenHash,
  newToken,
  equalHash,
} from "../functions/src/crypto.js";
it("salt が毎回異なり、正しいパスコードだけを認証する", async () => {
  const a = await hashPasscode("abcdef"),
    b = await hashPasscode("abcdef");
  expect(a.passcodeSalt).not.toBe(b.passcodeSalt);
  expect(a.passcodeHash).not.toContain("abcdef");
  expect(await verifyPasscode("abcdef", a)).toBe(true);
  expect(await verifyPasscode("wrong-passcode", a)).toBe(false);
});
it("256 bit token を発行し、hash だけを比較できる", () => {
  const token = newToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newToken()).not.toBe(token);
  expect(equalHash(tokenHash(token), tokenHash(token))).toBe(true);
  expect(equalHash(tokenHash(token), tokenHash(newToken()))).toBe(false);
  expect(equalHash("00", "")).toBe(false);
});
