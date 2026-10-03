/* scripts/cloudflare-worker-compare.mjs の検査用: Cloudflare API の偽物(子プロセスに --import で読み込む) */
import fs from 'node:fs';
const live = fs.readFileSync(process.env.MOCK_LIVE_FILE, 'utf8');
const mode = process.env.MOCK_MODE || 'raw';
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (!url.startsWith('https://api.cloudflare.com/client/v4/accounts/acc123/workers/scripts/mainiko-line')) throw new Error('unexpected ' + url);
  if (opt.method && opt.method !== 'GET') throw new Error('書き込みの呼び出しをしてはいけない: ' + opt.method);
  if (opt.headers.authorization !== 'Bearer read-only-token') return new Response('{}', { status: 403 });
  // MOCK_FAIL=schedules:403,settings:500 などで、その API だけを失敗させる
  for (const f of (process.env.MOCK_FAIL || '').split(',').filter(Boolean)) {
    const [part, code] = f.split(':');
    if (url.endsWith('/' + part)) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'mock ' + code }] }), { status: Number(code) });
  }
  if (process.env.MOCK_EMPTY_DEPLOYMENTS && url.endsWith('/deployments')) return new Response(JSON.stringify({ success: true, result: { deployments: [{ created_on: '2026-10-02T00:00:00Z', versions: [] }] } }));
  const json = (result) => new Response(JSON.stringify({ success: true, result }), { headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/content/v2')) {
    if (mode === 'multipart') { const f = new FormData(); f.append('worker.js', new Blob([live], { type: 'application/javascript+module' }), 'worker.js'); return new Response(f); }
    return new Response(live, { headers: { 'content-type': 'application/javascript', 'cf-entrypoint': 'worker.js' } });
  }
  if (url.endsWith('/schedules')) return json({ schedules: [{ cron: '*/15 * * * *' }] });
  if (url.endsWith('/settings')) return json({ compatibility_date: '2024-09-01', bindings: [{ name: 'FIREBASE_SERVICE_ACCOUNT', type: 'secret_text', text: 'SHOULD-NOT-PRINT' }, { name: 'LINE_CHANNEL_SECRET', type: 'secret_text' }] });
  if (url.endsWith('/deployments')) return json({ deployments: [{ created_on: '2026-10-01T00:00:00Z', versions: [{ version_id: '8b690aa7-1111-2222-3333-444444444444', percentage: 100 }] }] });
  throw new Error('unexpected ' + url);
};
