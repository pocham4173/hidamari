# まいにこ

離れた家族が、挨拶、予定、メッセージ、選んだ体調などを無理なく伝え合う「家族のゆるやかな連絡帳」です。24時間の見守り、安否確認、救急通報、診断、服薬証明を行うサービスではありません。

## 構成

- GitHub Pages: PWA画面
- Firebase Authentication: 匿名利用とメールリンク復旧
- Cloud Firestore: 家族ごとの共有データ
- Cloud Functions: 招待の一回消費、完全削除、メンバー解除、通知送信
- Firebase Cloud Messaging: アプリを閉じている間の通知
- Firebase App Check: 不正クライアントからの呼び出し抑止

公開前の外部設定、デプロイ順、実機検査は [RELEASE_READINESS.md](RELEASE_READINESS.md) にまとめています。
