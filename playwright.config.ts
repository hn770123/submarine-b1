/** Emulator Hosting に対して独立したブラウザの参加・復帰を検証する設定。 */
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5000",
    viewport: { width: 360, height: 800 },
  },
  reporter: "list",
});
