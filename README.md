# 深海戦術

plan.md の Phase 1〜3 の実装です。作成・参加・初期配置・交互の行動・リロード復帰までをブラウザで確認できます。盤面を使った本格的な対戦画面は Phase 4 で追加します。

## 開発環境

Node.js 22、npm、Java 21以上が必要です。Firebase の本番 credential は不要です。

```sh
npm ci
npm run build
npm run emulators
```

http://localhost:5000 を開いてください。Codespaces ではポート5000を転送します。独立したブラウザまたはシークレットウィンドウでゲストとして参加できます。パスコードは6〜64文字です。

Viteで開発する場合はEmulatorを起動したまま別ターミナルで以下を実行します。

```sh
npm run dev --workspace @submarine/web
```

## 検証

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx playwright install --with-deps chromium
npm run verify:emulators
```

統合テストは Firestore Emulator と実際の Express API を使い、二重送信・古い version・並行行動・秘密ビューも検証します。E2E は Hosting rewrite と Functions Emulator を通り、独立ブラウザで作成・参加・配置・行動・リロード復帰・三人目の拒否を検証します。360pxとデスクトップのスクリーンショットは `test-results/` に保存します。CIでは自動的にアップロードします。

## 構成

- `functions/src/`: PBKDF2、token hash、Firestore repository、HTTP API
- `src/shared/`: 型、設定、seed付き盤面、純粋ゲームエンジン
- `web/src/`: ルーム・配置・行動画面と sessionStorage を使う復帰
- `tests/`: ゲーム単体・暗号・Rules・Emulator API・E2E
- `docs/adr-001-phase1-2.md`: 未決事項の判断と確認した公式資料
- [検証結果とスクリーンショット](docs/validation-phase1-2.md)

`GET /api/v1/health`、`POST /api/v1/rooms`、`POST /api/v1/rooms/:code/join`、`GET /api/v1/rooms/:code/state`、`POST /api/v1/rooms/:code/placement`、`POST /api/v1/rooms/:code/actions`、`POST /api/v1/rooms/:code/leave` を提供します。state/placement/actions/leave は `Authorization: Bearer` が必要です。state は ETag による条件付きGETにも対応します。actions は `actionId`（UUID）、`expectedVersion`、`action` を要求し、同じ ID の再送は確定済み結果を返します。

## Firebase プロジェクト

Emulatorでは常に `demo-submarine` を使用し、本番への接続を避けます。実プロジェクトを選ぶ段階では `.firebaserc.example` を参考に `firebase use --add` を実行してください。実プロジェクトID・credential・秘密値はコミットしません。デプロイと TTL 設定、App Check、履歴整理は後続フェーズで扱います。

## 依存関係の監査

2026-09-29 の `npm audit` では、最新版の開発用 Firebase CLI の間接依存に中程度5件が残っています（高・重大0件）。Functions の実行用依存には該当しません。互換性を未確認の overrides や CLI のダウングレードは行わず、後続リリースで上流の修正を確認します。
