/** 未認証・認証済みどちらのクライアントも権威 collection を操作できないことを検証。 */
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, it } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
let environment: RulesTestEnvironment;
beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: "demo-submarine",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});
afterAll(async () => {
  await environment.cleanup();
});
it("すべての collection の読み書きを deny by default にする", async () => {
  for (const context of [
    environment.unauthenticatedContext(),
    environment.authenticatedContext("user"),
  ]) {
    for (const path of [
      "rooms/room",
      "rooms/room/players/player",
      "rooms/room/actions/action",
      "roomCodes/CODE",
      "rateLimits/key",
      "unknown/doc",
    ]) {
      const reference = doc(context.firestore(), path);
      await assertFails(getDoc(reference));
      await assertFails(setDoc(reference, { arbitrary: true }));
    }
  }
});
