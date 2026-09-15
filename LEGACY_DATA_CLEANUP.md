# 旧版の残存データ整理 — 技術保守担当用

このツールは作成・模擬検証済みです。本番の監査・削除はまだ実行していません。理絵さんが日常的にCLIを操作する運用にはしません。技術保守担当が監査結果を説明し、対象と件数について具体的な承認を得てから実行します。技術保守担当が不在の場合、有料提供の開始条件を満たしていません。

## できること・対象外

`scripts/legacy-data-cleanup.mjs` は既定で読取り専用です。親の世帯がサーバー上に存在しない既知の記録・予定・メンバー・settings/watchTag、招待、復旧用接続先、タグと通知を検出します。親ドキュメントが消えて子だけ残った場所も列挙します。存在する世帯は削除しません。古いという理由だけでは削除しません。

Auth削除後の `accountClosures/{uid}` は、監査でAuth側の `auth/user-not-found` を確認した時点をmanifestの `authAbsenceObservedAt` に記録します。その確認時点から24時間以上待ち、削除直前にもAuthの不存在を再確認した場合だけロックを削除できます。`requestedAt` は削除準備の日時であり、Authが実際に削除された日時ではないため、待機の起点には使いません。Authが残る場合、確認不能、時刻不正、復旧用accountsが残る場合にはロックを消しません。Authそのものをこのツールで削除することはありません。旧形式version 1のmanifestは使用できません。

未知のコレクション、未知のsettings文書、既知末端のさらに下にあるデータ、不正なgroupIdを発見すると未検証として報告し、apply全体を拒否します。内容と所有関係を別途調査してからschema対応を追加してください。全データベースを再帰的に無条件削除する機能はありません。

印刷済みQR、スクリーンショット、ダウンロード、他端末のオフラインコピー、運営側の別途バックアップ、Firebase以外の保管物は対象外です。手元の紙・画像の廃棄や端末のデータ消去は別途案内します。このツールの成功は、確認済みschemaの承認対象をFirestoreから除去できた意味です。

Authアカウントを削除しても、存続する別世帯のメンバー文書・記録の作成者UIDなどにその人の情報が残ることがあります。これは本ツールの自動削除対象外です。本人からの申出を受け、技術保守担当が対象世帯・本人との関係・共同利用者への影響を個別確認し、削除または必要な最小限の情報整理を具体的に提案して確認を得ます。別世帯の記録を一括で消したり、Auth削除だけで全保管先から個人情報が消えたと案内したりしません。

## 実行条件

1. 新しい権限ルールを本番へ反映し、消えた世帯への通常クライアント書込が拒否される状態にする。
2. 技術保守担当の正式なApplication Default Credentialsを用意する。権限のある運営環境にだけ `firebase-admin` をインストールする。ブラウザへのAdmin SDK・サービスアカウント鍵の配信、鍵のGitHub保存は禁止。
3. Firebaseプロジェクトが `hidamari-5f8de` であること、Sparkのままであること、当日の利用量を確認する。本ツールはFunctions・Blaze・有料bulk deleteサービスを必要としない。ただし読取りと削除は無料枠を消費する。無料枠不足なら日を分ける。課金への自動切替はしない。
4. 作業中の別のAdminスクリプト、管理コンソールでの同時書込・Authユーザー再作成を停止する。FirestoreとAuthを横断した原子的削除はできず、未知の子コレクション追加もトランザクションではロックできないため、この運営側の排他が必要。
5. manifestと結果ファイルの保存先はアクセス制限された運営用ディレクトリを選ぶ。内容本文は出ないがpathにはUID等が含まれる。公開PR・Issueに添付しない。所定の保管期限後に削除する。

## まず監査（変更なし）

リポジトリのルートで、技術保守担当が実行します。正式なADC認証はその担当者が組織の手順で設定してください。ユーザーのパスワードを預かりません。

```sh
node scripts/legacy-data-cleanup.mjs --project hidamari-5f8de --out /secure/mainico/audit-001.json
```

標準出力はモード、件数、complete、manifestHashのみ。詳細ファイルにはpath・理由・groupId・updateTimeのSHA-256と件数、未検証箇所、Auth閉鎖ロックについてのみAuth不存在確認日時を保存し、氏名・メール・伝言本文・位置等を出力しません。既存ファイルを上書きしません。既定の文書読取り上限は5,000（関連親の再読込みを含む）、指定可能な上限は10,000です。名前列挙や後続の再監査も通信を行うため、この数字はFirebaseの請求読取り数そのものではありません。

Auth閉鎖ロックが候補にある場合、この監査manifestをそのまま保管し、確認日時から24時間以上経過してからapplyします。待機前のapplyは `skipped-auth-absence-wait` として残し、ロックを消しません。新たなmanifestを作ると、その新しいAuth不存在確認日時から待機をやり直します。日時の手編集や端末時計の変更で待機を短縮しないでください。運営環境の時計は時刻同期したものを使います。

`complete:false` または終了コード1/2の場合、完了扱いにしません。未知schemaは担当が調べ、権限/通信/利用枠不足は解消して再監査します。エラー本文は個人内容混入を避けて出力しません。対象ゼロの場合も確認済みschemaの監査結果として保管し、削除操作は不要です。

## 確認後の限定削除

担当者は候補の理由・対象世帯ID・件数を理絵さんへ提示し、具体的な削除対象の承認を記録します。一般的な『ツールを作成して』という依頼は本番データ削除の承認として扱いません。以下の値は監査で得た実値に置換します。

```sh
node scripts/legacy-data-cleanup.mjs --project hidamari-5f8de --apply /secure/mainico/audit-001.json --confirm-hash ACTUAL_MANIFEST_SHA256 --groups ACTUAL_GROUP_ID --closure-uids ACTUAL_APPROVED_CLOSURE_UID --out /secure/mainico/result-001.json
```

複数IDはカンマ区切り。閉鎖ロック対象がなければ `--closure-uids` は省略し、世帯対象がなければ `--groups` は省略します。manifest内の全対象に明示確認が必要です。一部だけ承認する場合は勝手にmanifestを編集せず、対象分離を保守担当がレビューした上で新しい監査・確認手順を準備します。

applyは再監査した後、各対象をトランザクションで読み、親世帯が今もないこと・対象updateTimeが監査時と同じことを検査します。削除には `lastUpdateTime` 事前条件も指定します。タグ通知を先に削除し、通知が残るタグは削除しません。更新、親復活、未知schema、権限/通信失敗があればスキップまたは失敗として残し、成功を装いません。部分成功の場合は新たな監査manifestを作り、残った対象について再確認して再試行します。

完了時に再監査します。結果の `complete:true` は、承認対象の操作が成功し、同じ対象の既知残存物がその確認時点で見つからなかったことを示します。別世帯の未承認候補があれば `remainingCount` に残ります。紙やコピーの遠隔削除を保証する表示には使わないでください。

## 検証・一次資料

`node tests/legacy-data-cleanup.test.mjs` は認証不要の模擬テストです。親欠如・生存世帯保護・内容非出力・明示確認・削除順・更新競合・親復活・部分失敗と再試行・未知schema・Auth閉鎖待機を確認します。本番に接続しません。

- [CollectionReference.listDocuments（存在しない親の参照も返す）](https://googleapis.dev/nodejs/firestore/latest/CollectionReference.html#listDocuments)
- [Adminからの子コレクション列挙](https://firebase.google.com/docs/firestore/query-data/get-data#list_subcollections_of_a_document)
- [Transaction.delete / lastUpdateTime](https://googleapis.dev/nodejs/firestore/latest/Transaction.html#delete)
- [Admin Authのユーザー取得](https://firebase.google.com/docs/auth/admin/manage-users#retrieve_user_data)
- [Firestoreのトランザクション](https://firebase.google.com/docs/firestore/manage-data/transactions)

上記仕様を2026-09-15に確認しました。
