/** 開発時も API を同一オリジンへまとめる Vite 設定。 */
import { defineConfig } from "vite";
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:5000" } },
});
