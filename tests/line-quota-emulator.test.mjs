// Production quota/REST code, real local Firestore; no LINE or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const project = 'demo-mainico-quota';
const host = 'http://127.0.0.1:8080';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const u = new URL(String(url));
  assert.equal(u.origin, host, 'Only the local emulator may receive requests');
  assert.ok(u.pathname.includes('/projects/' + project + '/'), 'Only the isolated project may be used');
  return nativeFetch(url, options);
};
// Export existing classes only in memory; production worker remains unchanged.
const source = fs.readFileSync('worker.js', 'utf8') + '\nexport {UsageBook, Firestore, toFields};';
const {UsageBook, Firestore, toFields} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
function database() {
  const db = new Firestore({FIREBASE_SERVICE_ACCOUNT: JSON.stringify({project_id: project})});
  db.base = host + '/v1/' + db.root;
  db.token = async () => 'owner'; // Emulator admin: models the worker, not client Rules.
  return db;
}
const now = new Date('2026-10-21T00:00:00Z');
function book(at = now, used = 0) {
  const b = new UsageBook(database(), at);
  b.quota = {limit: 200, used};
  return b;
}
async function clear() {
  const r = await fetch(host + '/emulator/v1/projects/' + project + '/databases/(default)/documents', {method:'DELETE'});
  assert.ok(r.ok);
}
async function seed(path, value) { await database().set(path, value); }
async function read(path) { return database().get(path); }
try {
  await clear();
  const tag = await Promise.all([book(now,199).reserve('tag','a',1), book(now,199).reserve('tag','b',1)]);
  assert.equal(tag.filter(x=>x==='').length,1);
  assert.equal((await read('lineUsage/ledger-2026-10')).fields.used,200);
  console.log('PASS concurrent tag reservations: only one final monthly slot');

  await clear();
  const mixed = await Promise.all([book(now,149).reserve('schedule','a',1), book(now,149).reserve('hitokoe','b',1)]);
  assert.equal(mixed.filter(x=>x==='').length,1);
  assert.equal((await read('lineUsage/ledger-2026-10')).fields.used,150);
  console.log('PASS schedule/hitokoe share the same ledger and leave tag reserve');

  await clear();
  await seed('lineUsage/home',{day:'2026-10-21',count:19});
  const daily = await Promise.all([book().reserve('schedule','home',1),book().reserve('hitokoe','home',1)]);
  assert.equal(daily.filter(x=>x==='').length,1);
  assert.equal((await read('lineUsage/home')).fields.count,20);
  console.log('PASS concurrent household reservations respect daily limit');

  await clear();
  await seed('lineUsage/hitokoe-2026-10',{month:'2026-10',count:89});
  for(const id of ['a','b']) await seed('lineReceipts/'+id,{state:'reserved'});
  const cap = await Promise.all(['a','b'].map(id=>book().hitokoeReserve(id,'2026-10','lineReceipts/'+id)));
  assert.equal(cap.filter(x=>x==='').length,1);
  assert.equal((await read('lineUsage/hitokoe-2026-10')).fields.count,90);
  assert.equal((await read('lineUsage/ledger-2026-10')).fields.used,1);
  const receipts=await Promise.all(['a','b'].map(id=>read('lineReceipts/'+id)));
  assert.equal(receipts.filter(r=>r.fields.quotaMonth==='2026-10').length,1);
  console.log('PASS 90th hitokoe reservation and receipt mark commit atomically');

  await clear();
  assert.equal(await book().hitokoeReserve('a','2026-10','lineReceipts/missing'),'conflict');
  assert.equal(await read('lineUsage/ledger-2026-10'),null);
  assert.equal(await read('lineUsage/a'),null);
  assert.equal(await read('lineUsage/hitokoe-2026-10'),null);
  console.log('PASS missing receipt rolls back every quota write');

  await seed('lineUsage/ledger-2026-10',{month:'2026-10',used:200});
  assert.equal(await book(new Date('2026-10-31T15:00:00Z')).reserve('schedule','a',1),'');
  assert.equal((await read('lineUsage/ledger-2026-10')).fields.used,200);
  assert.equal((await read('lineUsage/ledger-2026-11')).fields.used,1);
  console.log('PASS JST month boundary uses a new ledger without resetting the old one');

  const db=database();
  await seed('lineReceipts/stale',{state:'reserved'});
  const old=await db.get('lineReceipts/stale');
  await db.set('lineReceipts/stale',{state:'accepted'});
  assert.equal(await db.commit([{update:{name:db.root+'/lineReceipts/stale',fields:toFields({state:'unknown'})},currentDocument:{updateTime:old.updateTime}}]),false);
  assert.equal((await read('lineReceipts/stale')).fields.state,'accepted');
  console.log('PASS stale updateTime cannot overwrite an accepted receipt');
  console.log('LIMIT: no LINE delivery, Cloudflare runtime, deployed Rules, or device validation');
} finally { await clear(); globalThis.fetch=nativeFetch; }
