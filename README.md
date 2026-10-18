# Now

モバイルファーストの個人用タスクアプリ。画面上部ですぐメモを追加し、理由付きの「今やること」を1件ずつ進めます。

公開URL：[now-task.now-task.workers.dev](https://now-task.now-task.workers.dev/)

ソース：[taisei004/now-task](https://github.com/taisei004/now-task)

## 操作

- 開くと入力欄にフォーカス。改行を含むラフな文章を登録できます。Ctrl / ⌘ + Enterでも追加。
- 「今日」「明日」「明後日」「2026/11/2」と「重要」「至急」「急ぎ」を端末内で読み取ります。期限・重要度は詳細画面で修正できます。勝手な期限の補完はしません。
- 右フリックで完了、左フリックで理由を選んで保留。ボタンでも同じ操作ができます。変更直後の通知から取り消せます。
- 完了すると次の1件を表示。10分タイマーは一時停止・再開でき、再読み込みやバックグラウンドへの移動を挟んでも終了時刻を保持します。
- 未完了・保留・完了を切り替え、検索と編集ができます。
- Googleログイン前もブラウザ内に保存。ログイン後はユーザー別にCloudflare D1へ同期し、端末内の既存タスクを明示的に取り込めます。

## 技術の選定理由

| 技術 / 直接依存                                                        | 採用理由と役割                                                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                                             | 画面・API・タスク型の整合性を確認するため。ブラウザとWorkerで型を共有します。                                                                         |
| React / React DOM                                                      | 入力、タスク、同期、タイマーの表示状態を一貫して更新するため。検索流入を目的としないアプリなのでSPAにしています。                                     |
| Vite / @vitejs/plugin-react                                            | 高速な開発・本番ビルドとReactの更新に使用。サーバーレンダリング用の追加基盤は設けません。                                                             |
| @cloudflare/vite-plugin                                                | 開発時もCloudflareのworkerdでAPIを動かし、静的ファイルとWorkerをまとめてビルドするため。                                                              |
| Cloudflare Workers / Static Assets                                     | フロントとAPIを同じオリジンで配信し、別サーバーやCORS設定の運用を減らすため。                                                                         |
| Hono                                                                   | Workersで動く小さなAPIルーター。認証、入力サイズ制限、エラー応答をまとめます。                                                                        |
| Cloudflare D1                                                          | タスク、Googleユーザー、セッション、AIキャッシュをSQLで保存し、ユーザー単位で所有権を制御するため。                                                   |
| Workers AI                                                             | 指定されたCloudflareのAI基盤で、次のタスク・理由・10分の着手内容を生成するため。APIキーをブラウザに渡しません。                                       |
| Llama 3.3 70B FP8 Fast                                                 | Workers AIの公式提供モデルで、文章から短い選択結果を返す用途に採用。`AI_MODEL`で差し替え可能です。日本語の実応答品質は接続後に確認します。            |
| Google OpenID Connect + jose                                           | Googleだけのログインを実現。公式公開鍵でIDトークンの署名、発行元、有効期限、対象クライアント、nonceを検証するため。外部の認証SaaSは追加していません。 |
| IndexedDB + idb                                                        | ネットワーク待ちを挟まず入力を端末へ保存し、通信失敗時の未同期タスクや下書きを保持するため。アカウントごとに保存領域を分けます。                      |
| Motion                                                                 | フリック操作、タスクの入れ替え、一覧の追加・削除、タブ移動を滑らかにするため。                                                                        |
| CSS                                                                    | 半透明、背景ぼかし、境界の光、影で白いLiquid Glass UIを作ります。画像を使わず、初期スケルトンやモーダルも軽量に表示します。                           |
| Lucide React                                                           | 操作に必要なアイコンを統一し、使用分だけビルドに含めるため。                                                                                          |
| Zod                                                                    | サーバーでタスクとAI出力を検証するため。ブラウザへの配信対象から分離しています。                                                                      |
| Wrangler                                                               | D1の作成・マイグレーション、秘密情報の登録、Workersの公開を公式CLIで行うため。                                                                        |
| Vitest / Node SQLite                                                   | 優先順位とAPIの回帰テストに使用。実際のSQLマイグレーションをSQLiteで実行し、ユーザー分離などを検証します。                                            |
| Prettier                                                               | ソースを読みやすく整形する開発用ツール。実行時には含みません。                                                                                        |
| pnpm                                                                   | ロックファイルによる依存の固定と再現可能なインストールのため。依存スクリプトはesbuildとworkerdだけ許可しています。                                    |
| @types/react, @types/react-dom, @types/node, @cloudflare/workers-types | 使用するランタイムのAPIを型チェックするため。実行時には含みません。                                                                                   |
| Web App Manifest / SVGアイコン                                         | ホーム画面用のアプリ名・アイコン・表示形式を定義します。サービスワーカーは実装しておらず、オフラインでの新規読み込みは保証しません。                  |

## データ・認証・AI

1. メモ追加・編集は先にIndexedDBへ保存します。同期失敗時にもローカルの変更を維持します。
2. ログイン後、未同期の変更を50件ずつ送信し、成功した変更だけ同期済みにします。接続復帰・画面の再表示・手動操作で再同期します。
3. D1のSQLはすべて対象ユーザーIDを条件にします。他ユーザーに同一のタスクIDが存在しても干渉しません。
4. 複数端末で同じタスクを編集した場合は、サーバーが最後に受理した編集を採用します。リアルタイム共同編集や履歴復元は対象外です。
5. GoogleログインはAuthorization Code + PKCE + state + nonce。状態は10分で失効し、一度だけ使用できます。セッションはランダムな値を発行し、D1にはハッシュだけ保存。HTTPS時はSecure / HttpOnly / SameSite=Lax Cookieを使います。
6. 書き込みAPIはOriginとJSON形式を確認し、128 KiBを上限にします。クライアントにGoogleの秘密情報は渡しません。
7. 推薦はD1内の未完了タスクだけを使います。最大40件を優先順で選んでWorkers AIに渡し、存在しないIDや不正な出力を拒否。当日・超過期限のタスクをAIが後回しにする場合もルールに戻します。
8. AIに接続できない場合は、期限・重要度・登録順による推薦と、その理由を表示します。AIが実行されたときだけWorkers AIと表示します。ローカル推薦をAIの実行結果とは表示しません。
9. AI結果は同じ入力に対して1時間キャッシュし、利用はユーザーとサーバーのUTC日付単位で制限します。初期値は100回です。モデルへ送るタスク本文は各250文字までに絞り、長いメモで入力上限を超えにくくします。

## ローカル開発

Node.js 24とpnpm 11.25.0を使用します。

```sh
pnpm install --frozen-lockfile
pnpm db:local
pnpm dev
```

`http://127.0.0.1:5173/` を開きます。Google・Cloudflare認証がなくても端末内メモを試せます。

Googleをローカルで接続する場合は `.env.example` を参考に `.dev.vars` を作成し、Google側に `http://127.0.0.1:5173/auth/google/callback` を登録します。

Workers AIを開発時にも実呼び出しする場合だけ、Cloudflare認証後に `CF_REMOTE_BINDINGS=true` を指定して起動します。初期状態では外部AIに接続しません。

```sh
pnpm test
pnpm build
```

ブラウザ操作による確認結果と未検証事項は [docs/TESTING.md](docs/TESTING.md) に記録します。

## Cloudflareへの公開

1. `pnpm exec wrangler login` で自身のアカウントへログイン。
2. `pnpm exec wrangler d1 create now-task` でD1を作成。
3. 返されたIDで `wrangler.jsonc` の `database_id` を置き換えます。初期のゼロIDはローカル専用です。
4. `pnpm db:remote` でマイグレーションを適用。
5. `pnpm deploy` で公開。出力された `https://…workers.dev` が本番URLです。
6. 下記のGoogle設定を行い、本番のGoogleログインとWorkers AIを確認します。

## Googleログインを登録する

「OAuthクライアント」は、このアプリがGoogleログインを使うための登録情報です。Google Cloudの課金APIキーとは別のものです。

1. [Google Cloud Console](https://console.cloud.google.com/)で、このアプリ用のプロジェクトを選択または作成します。
2. 「Google Auth Platform」でアプリ名 `Now`、サポート用メール、Audienceを設定します。開発中はテスト用として自分のGoogleメールアドレスをテストユーザーに追加します。
3. Clientsから「OAuthクライアントを作成」→種類「ウェブアプリケーション」。
4. 承認済みリダイレクトURIに **本番URL + `/auth/google/callback`** を正確に登録します。必要ならローカルのURIも追加します。
5. Client IDとClient Secretを取得します。SecretはGitHubやチャットに貼りません。
6. PowerShellで `./scripts/configure-google.ps1 -AppOrigin https://実際の公開先.workers.dev` を実行し、IDとSecretを入力します。Secretは非表示入力し、標準入力でCloudflareへ登録します。リポジトリには保存しません。

画面で設定する場合は、CloudflareのWorkers & Pagesから `now-task` → Settings → Variables and Secrets → Addを開きます。種類をSecretにして、下記の3項目を登録してDeployします。

| 名前                   | 値                                                               |
| ---------------------- | ---------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Googleで発行されたクライアントID                                 |
| `GOOGLE_CLIENT_SECRET` | Googleで発行されたクライアントシークレット                       |
| `APP_ORIGIN`           | `https://now-task.now-task.workers.dev`（末尾に `/` を付けない） |

登録するCloudflareの秘密情報は `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`APP_ORIGIN` の3つです。ID自体は公開識別子ですが、設定の取り違えを避けるため一緒に管理します。

## 公式資料

- [Cloudflare Vite + React SPA](https://developers.cloudflare.com/workers/vite-plugin/tutorial/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers AIモデル](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)

## 公開前の確認

- OAuthの登録内容、Google同意画面、利用するGoogleアカウントは所有者が確認・承認します。
- GoogleログインとWorkers AIの本番接続は、実際のアカウントで操作してから合格扱いにします。ローカルのモックによる合格とは区別します。
- 通知・カレンダー連携・自然文による複数タスクへの分割は、今回の実装には含めていません。
