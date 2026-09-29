# Phase 1・2 検証結果

検証日: 2026-09-29。ローカル環境は Node.js 24.21.0、Java 25、Firebase demo project `demo-submarine`。Functions の配信設定と CI は Node.js 22。

| 検証                       | 結果                                        |
| -------------------------- | ------------------------------------------- |
| `npm test`                 | 単体テスト31件成功（エンジン29件、暗号2件） |
| `npm run verify:emulators` | API・Rules 12件、ブラウザE2E 1件成功        |
| `npm run typecheck`        | 成功                                        |
| `npm run lint`             | 成功                                        |
| `npm run format:check`     | 成功                                        |
| `npm run build`            | Web・Functionsとも成功                      |

API の並行参加で1人だけが成功し、二席を超えないことを確認した。誤パスコード、満員、重複参加、期限切れ、別ルームの token、ゲスト・ホスト退出、条件付き GET、共有レート制限も確認した。未認証・認証済み双方のクライアントで権威 collection の直接読み書きが拒否され、待機ビューにパスコード hash、token hash、完全なゲーム状態が含まれないことを確認した。

E2E は Hosting rewrite を経由した作成・参加、独立コンテキストでのホスト／ゲストのリロード復帰、三人目の拒否を検証した。ホストの入力は Tab と Enter で操作し、動きの低減を有効にした。360px幅で横スクロールがないことを自動確認し、以下の画像を目視確認した。

- [参加待ち・360px](screenshots/room-waiting-360.png)
- [二人参加・360px](screenshots/room-ready-360.png)
- [二人参加・1280px](screenshots/room-ready-desktop.png)

途中で見つかった SDK の Timestamp インスタンス不一致、Hosting rewrite の Host 変更、Firestore のランダム文書IDによる参加者順序の変動を修正した。SDK を workspace 全体で一致させ、元の配信ホストを検証し、プレイヤー一覧をホスト・ゲスト順で返す。

CI ワークフローは追加済みだが、リモートの GitHub Actions 実行は未実施。初期配置・行動 API、対戦 UI、App Check、本番デプロイは後続フェーズ。依存監査の残存事項は README に記載。
