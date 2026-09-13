# 公開・商品化判定

## 判定

コードを `main` に置いただけでは商品化完了ではありません。次の必須条件をすべて満たし、本人端末・管理家族端末・一般家族端末で実機確認できた時点で公開可とします。

## 公開前の外部設定（未設定なら公開停止）

- FirebaseをBlazeプランにし、Cloud Functionsを利用可能にする。
- Authenticationで「匿名」と「メールリンク」を有効化し、`pocham4173.github.io` を承認済みドメインにする。
- App CheckでWebアプリをreCAPTCHA Enterpriseへ登録し、`mainico-config.js` の `MAINICO_RECAPTCHA_SITE_KEY` を設定する。
- App Checkの指標を確認後、Cloud Firestore・Authentication・Cloud Functionsで適用を有効にする。
- Cloud MessagingでWeb Push証明書を作成し、`mainico-config.js` の `MAINICO_VAPID_KEY` を設定する。
- プライバシー文書へ、提供者名、住所、責任者、非公開の問い合わせ先、受付時間、返信目安を記載する。
- 障害の監視先、通知先、復旧担当者、障害告知方法を決める。

## デプロイ順

互換性のない途中状態を公開しないため、次の順を守ります。

1. Cloud Functionsをデプロイする。
2. Firestore Rulesをデプロイする。
3. Callable Functionsの作成・招待・解除・削除を検証する。
4. GitHub Pagesの画面を公開する。
5. Service Workerの更新を確認し、旧画面と新画面をそれぞれ再読み込みして確認する。

例:

```sh
firebase deploy --project hidamari-5f8de --only functions
firebase deploy --project hidamari-5f8de --only firestore:rules
```

## 必須の3端末テスト

- [ ] 本人端末でモードを固定後、通常操作では家族画面へ切り替わらない。
- [ ] 管理家族だけが、承認・解除・管理家族指定・招待・薬編集・タグ停止・全削除を行える。
- [ ] 一般家族では管理操作が表示されず、直接書き込みもRulesで拒否される。
- [ ] 別の家族グループのIDを指定しても、記録・予定・薬・メンバーを読めない。
- [ ] 同じ招待コードを同時に2台で使い、片方だけ成功する。
- [ ] 招待コードの総当たりをApp Checkが拒否し、異常が監視に出る。
- [ ] 本人の挨拶・服薬ボタンを連打しても、同じ日・時間帯は1件だけになる。
- [ ] 本人に複数の連絡を送り、古い連絡が一覧に残り、選んだ連絡へ返事できる。
- [ ] 機内モードで起動・月表示・送信を試し、「0件」や無限の読み込みにならず再試行できる。
- [ ] 復旧メールを元端末で登録し、新端末で同じ家族へ戻れる。
- [ ] ホーム画面に追加したiPhoneで通知を許可し、アプリを閉じた状態で通知が届く。
- [ ] 通知本文に薬名、体調、メッセージ本文などの詳細が出ない。
- [ ] 薬を変更・服用終了にし、確認日と履歴が正しく残る。
- [ ] 一般家族の端末を解除し、メンバー、通知トークン、復旧プロフィール、Auth利用者が残らない。
- [ ] テスト用家族を全削除し、group配下、招待、タグ、通知、プロフィール、Auth利用者が残らないことを管理画面で確認する。

## 自動検査

```sh
node .github/scripts/check-basics.mjs
node tests/home-reliability.test.mjs
firebase emulators:exec --only firestore --project demo-mainico "node tests/alerts.test.mjs"
cd functions && npm audit --omit=dev && node --check index.js
```

自動検査は実機、通知配信、削除後のFirebaseコンソール確認、法務確認の代わりにはなりません。
