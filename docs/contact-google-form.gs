/**
 * まいにこ 問い合わせ用の Google フォームを作る（1回だけ動かす）
 * 使い方：script.google.com の新しいプロジェクトに、これを全部貼り付けて「実行」。
 * 終わると、下の「実行ログ」にフォームのアドレス（https://docs.google.com/forms/…/viewform）が出ます。
 */
function createMainicoContactForm() {
  var form = FormApp.create('まいにこ 問い合わせ');
  form.setDescription(
    'まいにこで困っていることを、運営者（川村 理絵）に伝えるフォームです。お返事に数日かかることがあります。\n\n' +
    '⚠️ 急ぐとき・命に関わるときは、119番・110番へ。このフォームは急ぎの連絡には使えません。\n' +
    '⚠️ 名前・パスワード・招待コード・病気のこと・記録の中身は書かないでください。'
  );
  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(false);
  form.setConfirmationMessage('送りました。ありがとうございます。お返事に数日かかることがあります。まいにこに戻るときは、画面を閉じてください。');

  form.addMultipleChoiceItem()
    .setTitle('1. 困っていること')
    .setChoiceValues(['使い方がわからない', '動かない・エラーが出る', '家族とつながらない', '機種変更・入れなくなった', 'やめたい・データを消したい', 'ご意見・その他'])
    .setRequired(true);
  form.addMultipleChoiceItem()
    .setTitle('2. 使っているスマホ')
    .setChoiceValues(['iPhone', 'Android（アンドロイド）', 'わからない'])
    .setRequired(true);
  form.addMultipleChoiceItem()
    .setTitle('3. このスマホの使い方')
    .setChoiceValues(['ご本人のスマホ', 'ご家族のスマホ', 'わからない'])
    .setRequired(true);
  form.addParagraphTextItem()
    .setTitle('4. くわしく（どの画面で、何を押したら、どうなったか）')
    .setHelpText('例：設定の「招待コードを作る」を押したら、「作れませんでした」と出ました。')
    .setRequired(true);
  var email = form.addTextItem()
    .setTitle('5. お返事がほしいときは、メールアドレス（なくても送れます）')
    .setHelpText('お返事だけに使います。');
  email.setValidation(FormApp.createTextValidation().requireTextIsEmail().setHelpText('メールアドレスの形で入れてください。').build());

  Logger.log('フォームのアドレス（これをコピーして送ってください）：' + form.getPublishedUrl());
  Logger.log('編集画面：' + form.getEditUrl());
}
