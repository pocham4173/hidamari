# QRおまもりタグ用 Firestore Rules

このPRは、現在Firebase Consoleに設定されているRulesを推測で上書きしません。
本番へ反映する前に、既存Rulesの `match /databases/{database}/documents` 内へ以下を統合し、Rules Simulatorで確認してください。

前提として、既存Rules内に次の判定関数が必要です。

```text
function signedIn() {
  return request.auth != null;
}

function approvedMember(groupId) {
  return signedIn()
    && exists(/databases/$(database)/documents/groups/$(groupId)/members/$(request.auth.uid))
    && get(/databases/$(database)/documents/groups/$(groupId)/members/$(request.auth.uid)).data.status == "approved";
}
```

統合するルール:

```text
match /groups/{groupId}/settings/watchTag {
  allow read, create, update: if approvedMember(groupId);
  allow delete: if false;
}

match /watchTags/{tagId} {
  allow create: if signedIn()
    && request.resource.data.keys().hasOnly(["groupId", "active", "createdBy", "createdAt"])
    && request.resource.data.groupId is string
    && request.resource.data.active == true
    && request.resource.data.createdBy == request.auth.uid
    && approvedMember(request.resource.data.groupId);

  allow read: if approvedMember(resource.data.groupId);

  allow update: if approvedMember(resource.data.groupId)
    && request.resource.data.groupId == resource.data.groupId
    && request.resource.data.createdBy == resource.data.createdBy
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(["active", "stoppedAt"]);

  allow delete: if approvedMember(resource.data.groupId);

  match /alerts/{alertId} {
    allow create: if signedIn()
      && alertId == request.auth.uid
      && exists(/databases/$(database)/documents/watchTags/$(tagId))
      && get(/databases/$(database)/documents/watchTags/$(tagId)).data.active == true
      && request.resource.data.keys().hasOnly(["type", "senderUid", "createdAt"])
      && request.resource.data.type == "found"
      && request.resource.data.senderUid == request.auth.uid;

    allow read: if approvedMember(
      get(/databases/$(database)/documents/watchTags/$(tagId)).data.groupId
    );

    allow update, delete: if false;
  }
}
```

## 必須確認

- 未ログインでは通知を書けない
- 匿名ログインした第三者はタグ本文と家族情報を読めない
- 承認済み家族だけがタグ発行・停止・通知閲覧できる
- 同じ匿名利用者は同じタグへ1回しか通知できない
- 停止済みタグには通知を書けない
- QRと読み取り画面に氏名、住所、電話番号、病歴、家族情報、位置情報が出ない

