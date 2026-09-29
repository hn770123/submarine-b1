// TypeScript の潜在的な誤りを検出する共通 lint 設定。
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/lib/**",
      "**/dist/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
