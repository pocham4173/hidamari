# まいにこ 通信切断・復旧時の検証記録

実施日：2026年10月16日（日本時間）
対象基準コミット：c874587336b8b517e99f4782a45e47d60ef72f3a
修正案：この記録と同じブランチの index.html。公開サイトには未反映。

## 範囲と環境
- 本番のHTML・保存関数・Firestoreルールを使い、架空の承認家族A/Bと未承認参加者をローカルエミュレーターに作成。
- 実利用者データ、本番Firebase、LINE送信、課金設定には接続・変更していない。
- Node 24.19.0 / firebase 10.14.1 / rules-unit-testing 3 / jsdom 26 / Java 17 / Firestore emulator 1.19.8。
- Firestore SDKの disableNetwork/enableNetwork で切断・復旧。DOMはJSDOMで実行。実ブラウザー・iPhone試験ではない。
- 新規検査では本番addEvent/sendMemo/addCareLogを抜き出して実行。VM境界のオブジェクトを保存前に浅くコピー。待機案内タイマーだけ10秒から0.1秒へ短縮。保存のSDK/ルールは実物。

## 結果
|検査|修正前|修正後|
|---|---|---|
|オフライン送信中に成功表示しない・入力保持|合格|合格|
|メモを送信待ち中に2回押す|不合格：復旧後2件|合格：復旧後1件|
|復旧後に別の承認家族が日時・記録者・本文を取得|合格（重複あり）|合格（1件）|
|送信待ち中に新たに書いた文章を消さない|合格|合格|
|電話・訪問の記録を連打し復旧|各1件で合格|各1件で合格|
|長い送信待ちを成功/失敗と誤認させない案内|メモの状態案内なし、電話/訪問は記録中のまま|未確認のままである案内を確認|
|保存ルール拒否時の失敗表示・入力保持|合格|合格|
|2つの認証ID間の挨拶→返事→返事（実DOM）|今回の修正後に実施|合格|
|家族画面の通信切断→再試行→復旧、表示・入力保持|今回の修正後に実施|合格|
|未承認参加者の閲覧・返信拒否|今回の修正後に実施|合格|
|家族ホーム既存回帰検査|今回の修正後に実施|合格|

別の家族によるメモ・電話・訪問記録の確認はサーバー読み取りを検証。個々の記録のiPhone描画は未検証。家族画面のDOM往復検査は挨拶・返事を対象としている。

## 修正案
1. メモ送信中の二重操作を処理内のフラグと無効ボタンで防止。
2. 保存確認中・成功・失敗を画面で区別。保存確認が遅い場合は、待機と別の控えを案内。
3. 電話・訪問にも同じ待機案内。タイムアウトを勝手に失敗扱いして再送しない。
4. 成功応答より後に編集された入力を保持。自動バックアップ/再起動後復元は追加していない。

## 未確認・限界
- iPhone/Safari/Android実機の表示と操作、OS休止やアプリ終了/再読み込み後の未送信復旧。
- 実サービス全体の停止、DNS/CDN障害、長時間障害、バックアップ復元、LINE未達。
- SDK切断はサーバー停止そのものではない。本番の障害耐性が保証されたとは判断しない。
- 同一画面で処理継続中の重複を防止。別タブ・端末・再起動をまたぐ完全な重複排除ではない。
- 保存ルール拒否による失敗を試験。ネットワーク途中切断は失敗確定せず、復旧待ちとして試験。

## 再実行
作業ディレクトリをリポジトリルートにする。
1. npm install --no-save --package-lock=false @firebase/rules-unit-testing@3 firebase@10.14.1 jsdom@26
2. JavaでローカルFirestoreエミュレーターを127.0.0.1:8080に起動（demoプロジェクトのみ）。
3. node tests/outage-recording-emulator.test.mjs
4. node tests/home-conversation-emulator.test.mjs
5. node tests/home-reliability.test.mjs
本環境ではSDKのローカルgRPC通信をプロキシが妨げたため、検査プロセスに限りHTTP_PROXY/HTTPS_PROXY/ALL_PROXYと小文字版を外した。
修正前再現は基準コミットのindex.htmlと新規検査を使い EXPECT_BASELINE=1 を設定。新規検査は既存のdemo-mainico-outageエミュレーターデータを初期化する。

## 試験準備時の問題（製品不具合とは区別）
- 別の実行セッションに立てたエミュレーターへ接続できず、同じシェル内で起動・検査する形に変更。
- 同一テストコンテキストのfirestore()再呼び出しによる設定エラーを、同じDBインスタンスの再利用で修正。
- JSDOMとSDKのオブジェクト境界を浅いコピーで接続。
- ローカルgRPCのプロキシ干渉を検査プロセスで解消。
- 既存家族画面検査が、復旧直後にまだ存在しないボタンを参照して停止。存在するまで待つ判定へ修正。
以上の準備エラーを解消した後の結果を下記に収録。

## 検証したファイルのSHA-256
- `index.html`: `ec5516a88d8dbe587963a4de63cd2b5a70aaf703e4ee268e1ac0ffbd9a903a10`
- `firestore.rules`: `d345859a58d05aee76ecee8d8b05e6f26aaf2d33bf2ecd92f674392407039802`
- `tests/outage-recording-emulator.test.mjs`: `243b3feaafe29763989811b0ea385f92552311e1d53d77c1f4f6b9eac3e6f571`
- `tests/home-conversation-emulator.test.mjs`: `af2e9ab78bb96748c15f040663765df8bf7b64030329e8870d4a1f7f42ee158d`

## 修正前の再現ログ

```text
PASS offline: no server record, draft retained, no success acknowledgement
REPRODUCED BUG: two clicks while offline create two memo documents after reconnection
PASS newer draft survives previous write acknowledgement
PASS call/visit: pending clicks create one record each, confirmed only after recovery
[2026-10-16T11:39:01.737Z]  @firebase/firestore: Firestore (10.14.1): GrpcConnection RPC 'Write' stream 0x8a5e3678 error. Code: 7 Message: 7 PERMISSION_DENIED: 
evaluation error at L252:26 for 'create' @ L252, false for 'create' @ L612, false for 'create' @ L252, false for 'create' @ L612
PASS actual rules rejection retains draft and displays failure
LIMIT: no iPhone, real server outage, reload recovery or full backup restoration tested
```

## 修正後ログ

```text
PASS offline: no server record, draft retained, no success acknowledgement
PASS retry clicks blocked; one memo reaches approved family B with author/date/text
PASS newer draft survives previous write acknowledgement
PASS call/visit: pending clicks create one record each, confirmed only after recovery
[2026-10-16T11:39:38.899Z]  @firebase/firestore: Firestore (10.14.1): GrpcConnection RPC 'Write' stream 0x12142458 error. Code: 7 Message: 7 PERMISSION_DENIED: 
evaluation error at L252:26 for 'create' @ L252, false for 'create' @ L612, false for 'create' @ L252, false for 'create' @ L612
PASS actual rules rejection retains draft and displays failure
LIMIT: no iPhone, real server outage, reload recovery or full backup restoration tested
```

## 家族画面ログ

```text
PASS actual two-identity home roundtrip: yesterday greeting → family reply → person thanks → continued reply
PASS real offline/cache/retry retains visible content and typed draft
PASS pending participant cannot read conversations or send replies
```

## 既存回帰ログ

```text
✅ 家族ホームはワンタップ記録を先に、補助入力を開閉式に表示
✅ 家族・家族のみのタブは画面上部から開く
✅ タグの最優先表示は未確認の間だけ
✅ タグも通信未確認と確定した通知を区別する
✅ 起動が止まれば縦並びの再試行と段階を表示し、起動済みの画面は妨げない
✅ 通信失敗では0件と表示せず、再試行できる
✅ 伝言の確認は家族ごとに区別し、他人の確認で自分を確認済みにしない
✅ 月のまとめに家族の伝言・やることを生活記録と区別して残す
✅ 期間グラフは項目を押すと期間別件数と記録内容が分かる
✅ ホームには当日の挨拶・お願い・返事を残し、返信済みも消さない
✅ ふり返りで当日・自分の記録だけ取り消せる
✅ 家族のみホームの今日・明日とその後の予定、通信失敗を区別する
✅ 家族の伝言は保存済み・最新確認済み・通信エラーを区別する
✅ 家族のみホームの未完了・期限超過・通信失敗を区別する
✅ ワンタップ記録の結果はその場で名前と時刻を確認できる
✅ お薬情報は承認家族の共有データとして登録・確認できる
✅ 家族への伝言入口は一覧と入力欄を開き、入力内容を保持する
```
