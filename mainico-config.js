/* Firebase App Check の公開用サイトキーです。秘密鍵は置かないでください。 */
window.MAINICO_RECAPTCHA_SITE_KEY = window.MAINICO_RECAPTCHA_SITE_KEY || '6LdvSrktAAAAAGBxlUhBFFb7yn6inWPKJIM2vK7x';
/* LINEでログインの送信役(Cloudflare Worker)の場所。例: 'https://mainico-line.〇〇.workers.dev'（最後の / は付けない）。
   空のあいだは、LINEでログインを出さず、これまで通りの入口になります。秘密の値ではありません。 */
window.MAINICO_LINE_AUTH_URL = window.MAINICO_LINE_AUTH_URL || '';
/* 試験環境(mainiko-line-staging)では、配るときにこのファイルを差し替えて次を入れる(本番では入れない):
   window.MAINICO_FIREBASE_CONFIG = { テスト用 Firebase プロジェクトのウェブ設定(公開してよい値) };
   window.MAINICO_STAGING = true;   // 試験用の表示を出す
   window.MAINICO_RECAPTCHA_SITE_KEY = '';   // 試験環境では App Check を使わない */
