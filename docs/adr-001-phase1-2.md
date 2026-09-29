# ADR 001: ルーム認証と決定論的ゲーム規則

決定日: 2026-09-29

## 範囲

Phase 0 のコードが未作成だったため、Phase 1・2 の実行に必要な workspace、Hosting、第二世代 HTTP Functions、Emulator、Rules、検証スクリプトを追加する。初期配置 API、行動 API、対戦画面は Phase 3・4 に残す。待機 UI では二人の参加まで確認できる。

## ルームと復帰

- ルームコードは乱数 48 bit の大文字16進12文字。推測耐性を優先し、transaction で予約して衝突時は再生成する。
- パスコードは6〜64文字、PBKDF2-SHA256、16 byte salt、60万反復。token は乱数256 bit、保存時はSHA-256 hashのみ。
- token は URL・localStorage に置かず、同じタブの sessionStorage に保存する。リロード復帰が可能。タブを閉じた場合や別端末への移行は非対応。HttpOnly cookie はより強い XSS 耐性を持つが、Bearer API と整合させるため今回は採用しない。CSPを併用する。
- 重複参加は本人の Bearer token を送ることで既存席に復帰する。token のない同名参加は新規参加とみなし、満員なら拒否する。応答を失って token を受け取れなかった参加の自動再送は行わない。
- 両者が参加すると `placement` に移る。配置確定前のゲスト退出は席を解放し `waiting` に戻す。ホスト退出は room を `expired` にする。
- 待機期限は作成から24時間、API が毎回検査する。TTL削除設定は本番運用フェーズで `rooms`、`roomCodes`、`rateLimits` に設定する。TTL はサブコレクションを削除しないため、運用段階で削除処理が必要。
- Functions は東京、minInstances=0、maxInstances=4、concurrency=40、timeout=30秒。永続的なFirestoreの固定窓レート制限を作成・参加・状態取得に適用する。App Check は Phase 5 で追加する。

## ゲーム規則 version 1

- 座標は0始まり、北は y 減少。初期配置はホストが上3行、ゲストが下3行。地形は seed 付き LCG で生成し、海域を分断する岩礁を取り消す。配置域は岩礁を置かない。
- 一行動は前進1マス、左右90度旋回、ソナー、発射のいずれか。盤外・岩礁・相手のセルへの前進は拒否する。拒否は入力状態を変更せず、手番を消費しない。
- ソナーはマンハッタン距離5。supercover直線で角の岩礁も遮蔽する。捕捉時は位置と向きを記録。発信者の位置と向きは遮蔽・距離にかかわらず敵へ伝わる。探索して未検出の可視海域は候補から除く。
- 候補は座標だけでなく向きを保持する。相手が一行動したときだけ、停止・前進・左右旋回を展開する。実際の行動種別は使用せず、真の位置から候補を計算しない。最初の候補は相手の配置域の全方向。
- 解決順は潜水艦の行動 → その移動先にある既存魚雷との接触 → 既存魚雷の一マス同時更新 → 爆発・被害の一括適用 → 勝敗 → 手番交代。新規魚雷は発射時に一マス前へ置き、同じ手番中には再移動しない。
- 魚雷は岩礁、潜水艦、他の魚雷、射程終了で爆発。互いのセルを入れ替える魚雷も衝突する。盤外に出た魚雷は消滅する。初期射程18、1行動につき1マス。
- 爆発は同じセルなら一回に集約する。直撃70、マンハッタン距離1の隣接25、自艦も被害を受ける。複数セルの爆発は加算し、同時撃沈は引き分け（winnerPlayerId=null）。
- 発射音と爆発は位置を含めない履歴に記録する。敵魚雷の距離3以内は主要方位だけを接近警報に記録する。履歴のプレイヤー別API変換と保存量の制限は Phase 3 で行う。
- エンジン内では時刻・暗号乱数・通信を使用しない。保存済みの未知設定バージョンは拒否する。初期配置は `createGame` の placements の挿入順で host、guest を渡す契約とする。

## 参照した公式資料

2026-09-29 に以下を確認した。

- https://firebase.google.com/docs/functions/http-events
- https://firebase.google.com/docs/hosting/functions
- https://firebase.google.com/docs/firestore/manage-data/transactions
- https://firebase.google.com/docs/emulator-suite/install_and_configure
- https://firebase.google.com/docs/rules/unit-tests
- https://nodejs.org/api/crypto.html
- https://vite.dev/guide/
- https://react.dev/reference/react/useEffect
- https://zod.dev/basics
- https://playwright.dev/docs/intro
- https://vitest.dev/guide/
- https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs
- https://docs.github.com/en/actions/tutorials/store-and-share-data
- https://github.com/actions/setup-java

Transaction callback に乱数生成やパスコード導出を置かず、全読み取りを更新より前に行う。クライアントの直接アクセスは deny by default とする。
