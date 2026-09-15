# 端末復旧の準備と確認

この変更は、現在の匿名アカウントにメールとパスワードを追加し、同じ Firebase UID で別端末に戻れるようにします。新しい UID に既存の家族の記録を付け替えたり、メールアドレスだけで家族に参加させたりはしません。

実装済みのコードと、運営による Firebase 設定・メール到達確認・実機確認は別です。以下の設定と確認が済むまでは、運用資料に「復旧は本番確認済み」と記載しないでください。

## 運営が行う初回設定

1. Firebase Console の Authentication → Sign-in method で **Email/Password** を有効にします。匿名認証も維持します。メールリンク認証、SMS、Cloud Functions、Blaze への変更は、この復旧方式には不要です。
2. Authentication のメールテンプレートで、送信元表示名・日本語の確認メール・パスワード再設定メールを確認します。運営が管理するテスト用メールアドレスで、確認リンクと再設定リンクが届くことを確認します。
3. 公開先ドメインの設定を確認します。メール内のリンクに戻り先を追加する場合は、管理する許可済みドメインだけを指定します。現コードは Firebase 標準のメール処理画面を利用します。
4. 新しい `firestore.rules` をエミュレーターで確認し、アプリとルールを対応する版で公開します。旧ルールのままでは `accounts/{uid}` の保存が拒否され、復旧設定は完了しません。
5. プロジェクトのパスワード条件を確認します。アプリの新規設定は 12〜128 文字です。Firebase 側にこれより厳しい条件を追加する場合は、画面の案内も合わせます。既存のパスワードによる復旧は文字数を理由に遮断しません。
6. Firebase のメールアドレス列挙保護の設定を確認します。このコードは、ログインの「該当なし」「誤ったパスワード」を同じ文面にし、パスワード再設定も登録の有無を回答しません。API 自体の保護設定も公式手順で確認してください。料金プランや Identity Platform の変更を自動では行いません。
7. App Check を強制する場合は、一時的な復旧用 Firebase App にも同じサイトキーが渡ることを確認します。認証・Firestore のエラーを無視して成功扱いにしないでください。

標準のメール／パスワード認証を使うため Spark のまま構成できます。メール送信、認証、Firestore の無料枠・利用上限はプロジェクト単位で確認してください。上限超過を隠して「必ず届く」「無制限」と案内しません。

## 利用者への案内

- 復旧設定は、現在使えている端末で行います。家族や管理者は、自分が受信できるメールアドレスを使います。本人にパスワードを覚えることを強制しません。家族のアカウントを本人の入力であるかのように共用しないでください。
- メールとパスワードを登録しただけでは完了しません。メール内の確認リンクを開き、アプリの「確認できたか調べる」で復旧先と権限をサーバー確認できてから設定完了とします。
- 現在の端末に復旧未設定の登録がある場合、別アカウントへの切替は止めます。今の登録に戻れなくなるのを防ぐためです。まず現在の登録を確認し、復旧設定を完了します。
- 復旧設定前に端末と匿名アカウントの接続情報を失った場合、この方式で過去の UID を取り戻すことはできません。家族の管理者による新しい招待は別の参加者として行い、過去の入力者を変更しません。管理者自身を失った家庭は運営による個別確認が必要です。
- 参加承認の取消・削除中の家庭は、メールとパスワードを知っていても通常画面に復旧できません。削除中の管理者だけは、削除処理の再開に進めます。
- パスワードはアプリの localStorage、Firestore、ログに保存しません。復旧する端末は Firebase の認証状態を保持するため、共有端末での利用には注意します。

## 画面への接続方法

`firebase-*-compat.js` を読み込み、メイン Firebase App と `auth`、`db` を用意してから作成します。

```js
const recovery = MainicoRecovery.create({
  auth,
  db,
  credential: (email, password) =>
    firebase.auth.EmailAuthProvider.credential(email, password),
  serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp(),
  getLocalGroupId: gid,
  createIsolatedSession: MainicoRecovery.firebaseSessionFactory(
    firebase, previewApp.options, window.MAINICO_RECAPTCHA_SITE_KEY
  )
});
```

| API | 結果・扱い |
| --- | --- |
| `register({email,password,groupId})` | 同じ UID に認証方法と復旧先を追加。未確認時は `ready:false, status:'verification-sent'`。すでに同じメールで登録されている場合はパスワードで再認証し、途中失敗した復旧先保存を再試行する。 |
| `checkReady(groupId)` | メール確認状態を再取得し、復旧先と所属をサーバー照合。`ready:true` のときだけ設定完了。未登録は `not-configured`、未確認は `verification-required`。 |
| `resendVerification()` | 未確認時に確認メールを再送する。メール確認済みでも `check-required, ready:false` を返すため、続けて `checkReady` で復旧先を確認する。 |
| `resetPassword(email)` | 登録の有無にかかわらず同じ `reset-requested` と案内文を返す。通信失敗は成功にしない。 |
| `recover({email,password})` | 一時セッションで認証・メール確認・復旧先・現在の権限を検証してから本体の Auth を切り替える。成功時だけ復元先を端末に保存する。 |
| `MainicoRecovery.message(error)` | 画面に表示できる日本語の案内。生の SDK エラーや入力したメール・パスワードをログに出さない。 |

成功時の共通情報は `{uid, groupId, mode, name, role, owner, modeNeedsConfirmation, deletionPending, email}` です。`role` は本人／家族の表示区分で、管理者権限は `owner` により区別します。`mode` は `honnin / kazoku / konly` です。旧メンバーに `mode` がない家族は `modeNeedsConfirmation:true` となるため、「本人と家族が使う」「家族が記録して使う」を確認します。本人の旧 `role:honnin` は本人モードとして復元できます。

`deletionPending:true` は、管理者の削除再開専用です。通常の家族画面を表示しないでください。削除の最後まで管理者の account pointer を残す必要があります。

`beforeSwitch(context)` は認証切替直前に復元情報を1つの端末内journalへ保存し、旧購読を止めます。パスワードは含めません。保存に失敗した場合はAuthを切り替えません。起動時はjournalのUIDと認証中のUIDが一致するときだけ適用し、全設定の保存成功後にjournalを消します。旧家庭の端末内の服薬済み印・読み上げ位置・災害QRは引き継ぎません。

認証切替では `onAuthStateChanged` が呼ばれます。復旧処理中はアプリ側で `recoveryBusy` を立て、通常の自動起動を止めます。成功後に古い購読・家庭固有の画面状態を終了し、新しい接続情報を保存してから起動処理を明示的に再実行します。保存エラーがあれば完了と案内せず、復旧画面に留めます。失敗時は元の接続情報を変更しません。成功・失敗にかかわらず入力欄のパスワードは消去します。

## 検証

```sh
node --test tests/account-recovery.test.mjs
```

単体テストでは、同一 UID の維持、メール重複時の非統合、復旧先保存失敗、確認メール送信失敗、未確認・未承認・権限取消、通信失敗、旧モード、削除再開、別端末ログイン、匿名登録の保護、並行処理・セッション切替、エラーの個人情報抑制、一時セッションの後片付けを確認します。Firestore のルール検証はルール用エミュレーターテストで別途確認します。

運営のテスト用アカウントで、公開前に次を確認します。

1. 匿名で作った家庭をメール認証へ紐付けても UID と記録が変わらない。
2. 誤入力・重複メール・未確認メール・無効な確認リンク・通信切断で元の端末の記録を失わない。
3. メール確認後、別のテスト端末で同じ UID・同じ家庭・同じモードに戻れる。確認前は戻れない。
4. 復旧後にページを再読み込みしても同じ登録で開ける。一時セッションの後片付けで本体がログアウトされない。
5. パスワード再設定後に新しいパスワードで戻れ、古いパスワードでは戻れない。
6. 参加承認の取消後に復旧しても記録を開けない。削除中の管理者は削除再開画面へ進む。
7. モーダルを閉じる、戻る、二度押し、localStorage が使えない端末でも成功を誤表示しない。

Firebase の公式アカウント連携資料には一部プロジェクトの既知の連携問題への案内があります。現在使う SDK とプロジェクトで上記 1〜4 を実際に確認し、失敗時にアカウントを自動統合・削除する回避策は入れないでください。

## 参照した公式資料

確認日: 2026年9月15日。

- [Firebase: アカウントの連携](https://firebase.google.com/docs/auth/web/account-linking)
- [Firebase: パスワード認証の有効化・ポリシー・メールアドレス列挙保護](https://firebase.google.com/docs/auth/web/password-auth)
- [Firebase: 確認メール・パスワード再設定](https://firebase.google.com/docs/auth/web/manage-users)
- [Firebase: 認証状態の永続性](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [Firebase: Auth.updateCurrentUser API](https://firebase.google.com/docs/reference/js/v8/firebase.auth.Auth#updatecurrentuser)
- [Firebase: 料金](https://firebase.google.com/pricing)
- [Firebase: Authentication の利用上限](https://firebase.google.com/docs/auth/limits)
