#!/usr/bin/env node
// Trusted operator only. Never import this file into the web application.
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const PROJECT = 'hidamari-5f8de';
const DAY = 86400000;
const sha = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && !value.includes('/');
const timestampHash = snap => sha(`${snap.updateTime.seconds}:${snap.updateTime.nanoseconds}`);
const roots = new Set(['groups', 'watchTags', 'invites', 'accounts', 'accountClosures']);
const groupChildren = new Set(['events', 'yotei', 'members', 'settings']);
export function manifestHash(manifest) { return sha(JSON.stringify(manifest)); }

// Read all document names, including missing ancestors with surviving children.
// A finite schema prevents accidental recursive deletion of newly introduced data.
export async function audit(db, auth, {now = Date.now(), maxDocuments = 5000} = {}) {
  const entries = [], issues = [];
  let scanned = 0;
  const issue = (path, reason) => issues.push({path, reason});
  async function read(ref) {
    if (++scanned > maxDocuments) throw new Error('audit-document-limit');
    return ref.get();
  }
  async function children(ref, allowed) {
    const cols = await ref.listCollections();
    for (const c of cols) if (!allowed.has(c.id)) issue(c.path, 'unknown-collection');
    return cols.filter(c => allowed.has(c.id));
  }
  async function add(snap, reason, groupId = null) {
    if (snap.exists) entries.push({path: snap.ref.path, reason, groupId, updateTimeHash: timestampHash(snap)});
  }
  async function absentGroup(groupId, path) {
    if (!id(groupId)) { issue(path, 'missing-or-invalid-group-id'); return false; }
    return !(await read(db.doc(`groups/${groupId}`))).exists;
  }
  for (const col of await db.listCollections()) {
    if (!roots.has(col.id)) { issue(col.path, 'unknown-root-collection'); continue; }
    for (const ref of await col.listDocuments()) {
      const snap = await read(ref);
      const data = snap.exists ? snap.data() : {};
      if (col.id === 'groups') {
        for (const child of await children(ref, groupChildren)) {
          for (const leaf of await child.listDocuments()) {
            const leafSnap = await read(leaf);
            await children(leaf, new Set());
            if (child.id === 'settings' && leaf.id !== 'watchTag') issue(leaf.path, 'unknown-settings-document');
            else if (!snap.exists) await add(leafSnap, 'missing-group', ref.id);
          }
        }
      } else if (col.id === 'watchTags') {
        const cols = await children(ref, new Set(['alerts']));
        const missing = snap.exists ? await absentGroup(data.groupId, ref.path) : true;
        for (const child of cols) {
          for (const leaf of await child.listDocuments()) {
            const alert = await read(leaf);
            await children(leaf, new Set());
            if (missing && alert.exists) {
              const alertGroup = snap.exists ? data.groupId : alert.data().groupId;
              if (await absentGroup(alertGroup, leaf.path)) await add(alert, 'missing-group-tag-alert', alertGroup);
            }
          }
        }
        if (snap.exists && missing) await add(snap, 'missing-group-tag', data.groupId);
      } else {
        await children(ref, new Set());
        if (!snap.exists) continue;
        if (col.id === 'accountClosures') {
          const requested = data.requestedAt?.toMillis?.();
          if (!Number.isFinite(requested)) { issue(ref.path, 'invalid-closure-time'); continue; }
          if (requested > now) { issue(ref.path, 'invalid-closure-time'); continue; }
          try { await auth.getUser(ref.id); }
          catch (error) {
            if (error.code !== 'auth/user-not-found') throw new Error('auth-check-failed');
            await add(snap, 'auth-deleted-closure-observed');
            entries.at(-1).authAbsenceObservedAt = now;
          }
        } else if (await absentGroup(data.groupId, ref.path)) {
          await add(snap, col.id === 'accounts' ? 'dangling-account-pointer' : 'missing-group-invite', data.groupId);
        }
      }
    }
  }
  entries.sort((a,b) => a.path.localeCompare(b.path));
  issues.sort((a,b) => a.path.localeCompare(b.path));
  return {version: 2, project: PROJECT, scanned, count: entries.length, complete: issues.length === 0, entries, issues};
}

function validEntry(e) {
  if (!e || !/^[a-f0-9]{64}$/.test(e.updateTimeHash)) return false;
  const p = e.path?.split('/') || [];
  if (p.some(x => !id(x))) return false;
  if (p.length === 2 && p[0] === 'accountClosures') return e.reason === 'auth-deleted-closure-observed' && e.groupId === null && Number.isFinite(e.authAbsenceObservedAt) && e.authAbsenceObservedAt >= 0;
  if (!id(e.groupId)) return false;
  if (p.length === 4 && p[0] === 'groups' && p[1] === e.groupId && groupChildren.has(p[2])) {
    return e.reason === 'missing-group' && (p[2] !== 'settings' || p[3] === 'watchTag');
  }
  if (p.length === 4 && p[0] === 'watchTags' && p[2] === 'alerts') return e.reason === 'missing-group-tag-alert';
  return p.length === 2 && ({watchTags:'missing-group-tag',invites:'missing-group-invite',accounts:'dangling-account-pointer'})[p[0]] === e.reason;
}

export async function applyManifest(db, auth, manifest, {
  project, confirmHash, groupIds = [], closureUids = [], now = Date.now(), maxDocuments = 5000
} = {}) {
  if (project !== PROJECT || manifest.project !== PROJECT || manifest.version !== 2) throw new Error('wrong-project-or-version');
  if (manifestHash(manifest) !== confirmHash) throw new Error('manifest-hash-mismatch');
  if (!manifest.complete || manifest.issues?.length || manifest.count !== manifest.entries?.length || !manifest.entries.every(validEntry)) throw new Error('unverified-manifest');
  if (new Set(manifest.entries.map(e => e.path)).size !== manifest.entries.length) throw new Error('duplicate-path');
  const groups = new Set(groupIds), closures = new Set(closureUids);
  if (manifest.entries.some(e => e.groupId ? !groups.has(e.groupId) : !closures.has(e.path.split('/')[1]))) throw new Error('explicit-target-confirmation-required');
  // A fresh schema audit is mandatory; unknown collections block all mutation.
  const fresh = await audit(db, auth, {now, maxDocuments});
  if (!fresh.complete) throw new Error('current-schema-unverified');
  const freshMap = new Map(fresh.entries.map(e => [e.path, e]));
  const results = [];
  // Descendants before parent tags. Failures never prevent recording later results.
  const entries = [...manifest.entries].sort((a,b) => b.path.split('/').length - a.path.split('/').length || a.path.localeCompare(b.path));
  for (const entry of entries) {
    try {
      const current = freshMap.get(entry.path);
      // Fresh audit observes Auth again today; preserve the original approved
      // observation time for the 24-hour quarantine, never requestedAt.
      if (!current || current.reason !== entry.reason || current.groupId !== entry.groupId || current.updateTimeHash !== entry.updateTimeHash) { results.push({path:entry.path,status:'skipped-changed-or-ineligible'}); continue; }
      if (!entry.groupId && now - entry.authAbsenceObservedAt < DAY) { results.push({path:entry.path,status:'skipped-auth-absence-wait'}); continue; }
      const ref = db.doc(entry.path), p = entry.path.split('/');
      // An unknown/nested child makes a leaf unsafe to delete.
      const children = await ref.listCollections();
      if (children.some(c => !(p.length === 2 && p[0] === 'watchTags' && c.id === 'alerts'))) throw new Error('child-remains');
      if (!entry.groupId) {
        try { await auth.getUser(p[1]); throw new Error('auth-user-remains'); }
        catch (error) { if (error.code !== 'auth/user-not-found') throw new Error('auth-user-not-confirmed-deleted'); }
      }
      const status = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || timestampHash(snap) !== entry.updateTimeHash) return 'skipped-updated';
        if (entry.groupId) {
          if ((await tx.get(db.doc(`groups/${entry.groupId}`))).exists) return 'skipped-parent-restored';
          if (p[0] !== 'groups') {
            let groupId = snap.data().groupId;
            if (p.length === 4) {
              const tag = await tx.get(db.doc(`watchTags/${p[1]}`));
              if (tag.exists) groupId = tag.data().groupId;
            }
            if (groupId !== entry.groupId) return 'skipped-changed-group';
          }
          if (p.length === 2 && p[0] === 'watchTags') {
            if (!(await tx.get(ref.collection('alerts').limit(1))).empty) return 'skipped-child-remains';
          }
        } else {
          const time = snap.data().requestedAt?.toMillis?.();
          if (!Number.isFinite(time) || time > entry.authAbsenceObservedAt || now - entry.authAbsenceObservedAt < DAY) return 'skipped-closure-not-expired';
          if ((await tx.get(db.doc(`accounts/${p[1]}`))).exists) return 'skipped-account-pointer-remains';
        }
        tx.delete(ref, {lastUpdateTime:snap.updateTime});
        return 'deleted';
      });
      results.push({path:entry.path,status});
    } catch { results.push({path:entry.path,status:'failed-requires-new-audit'}); }
  }
  const after = await audit(db, auth, {now, maxDocuments});
  return {project:PROJECT, complete: results.every(r => r.status === 'deleted') && after.complete && !after.entries.some(e => e.groupId ? groups.has(e.groupId) : closures.has(e.path.split('/')[1])), results, remainingCount:after.count, issues:after.issues};
}

async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i=0;i<args.length;i++) {
    if (!['--project','--out','--apply','--confirm-hash','--groups','--closure-uids','--max-documents'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('invalid-arguments');
    opts[args[i].slice(2)] = args[++i];
  }
  if (opts.project !== PROJECT || !opts.out) throw new Error('explicit-project-and-output-required');
  const maxDocuments = Number(opts['max-documents'] || 5000);
  if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 10000) throw new Error('invalid-document-budget');
  const {initializeApp,applicationDefault} = await import('firebase-admin/app');
  const {getFirestore} = await import('firebase-admin/firestore');
  const {getAuth} = await import('firebase-admin/auth');
  const app = initializeApp({projectId:PROJECT,credential:applicationDefault()});
  const db = getFirestore(app), auth = getAuth(app);
  let result;
  if (opts.apply) result = await applyManifest(db,auth,JSON.parse(await readFile(opts.apply,'utf8')), {
    project:opts.project,confirmHash:opts['confirm-hash'],groupIds:(opts.groups || '').split(',').filter(Boolean),
    closureUids:(opts['closure-uids'] || '').split(',').filter(Boolean),maxDocuments
  });
  else result = await audit(db,auth,{maxDocuments});
  await writeFile(opts.out,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({mode:opts.apply?'apply':'dry-run',complete:result.complete,count:result.count,manifestHash:opts.apply?undefined:manifestHash(result)}));
  if (!result.complete) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  // Firebase error messages may contain document content: emit only a generic code.
  console.error('Cleanup stopped. No success claim. Check credentials, arguments, quota and restricted operator report; create a new dry-run before retry.');
  process.exitCode = 1;
});
