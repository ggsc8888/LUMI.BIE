import './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open, seal, sign } from '../server/crypto.js';
import { deleteDoc, getAll, importDesk, putDoc } from '../server/data.js';
import { settings } from '../server/env.js';
import { memoryBackend, tenantStore } from '../server/store.js';
import { evalGates, gatesPass, leakHits } from '../public/shared/gates.js';
import { admin, brand, draft, member } from './helpers.js';

const fresh = (tenant = 'org_A') => tenantStore(memoryBackend(), tenant);
const rejects = (promise, status, code) => assert.rejects(promise, e => e.status === status && (!code || e.code === code));
async function seeded() {
  const store = fresh();
  await putDoc(store, admin(), 'brands', 'agent', brand);
  await putDoc(store, member(), 'posts', 'p1', draft());
  return store;
}

test('sealed values open only with the same secret and purpose', () => {
  const s = 'a'.repeat(40), sealed = seal(s, 'tokens:org_A', { access: 'tok' });
  assert.deepEqual(open(s, 'tokens:org_A', sealed), { access: 'tok' });
  assert.equal(open(s, 'tokens:org_B', sealed), null);
  assert.equal(open('b'.repeat(40), 'tokens:org_A', sealed), null);
  assert.equal(open(s, 'tokens:org_A', sealed.slice(0, -2) + 'AA'), null);
  assert.notEqual(sign(s, 'x', 'a'), sign(s, 'y', 'a'));
});

test('blocked terms match whole ASCII words and any CJK occurrence', () => {
  const terms = ['ACE', 'ART', '蓝鲸', 'blue whale'];
  assert.deepEqual(leakHits({ body: 'We race to the start. Space for parties.' }, terms), []);
  assert.deepEqual(leakHits({ body: 'Meet ace by the art.', tags: ['#一头蓝鲸'] }, terms), ['ACE', 'ART', '蓝鲸']);
  assert.deepEqual(leakHits({ title: 'A Blue Whale demo' }, terms), ['blue whale']);
});

test('only admins manage product lines; posts need an existing line and platform', async () => {
  const store = fresh();
  await rejects(putDoc(store, member(), 'brands', 'agent', brand), 403);
  await rejects(putDoc(store, admin(), 'brands', 'Bad Id', brand), 400);
  await putDoc(store, admin(), 'brands', 'agent', brand);
  await rejects(putDoc(store, member(), 'posts', 'p1', draft('missing')), 400);
  await rejects(putDoc(store, member(), 'posts', 'p1', { ...draft(), platform: 'myspace' }), 400);
  const post = await putDoc(store, member(), 'posts', 'p1', { ...draft(), status: 'approved', ckLeak: true, approvedBy: 'x', mediaFile: { path: 'x' }, publishedVia: 'native' })
    .catch(e => e);
  assert.equal(post.status, 403, 'a member cannot approve or confirm at creation');
  const ok = await putDoc(store, member(), 'posts', 'p1', { ...draft(), mediaFile: { path: 'x' }, publishedVia: 'native', externalId: '1' });
  assert.equal(ok.status, 'draft'); assert.equal(ok.mediaFile, undefined); assert.equal(ok.publishedVia, undefined); assert.equal(ok.externalId, undefined);
});

test('approval needs every confirmation, and editing the words takes it back', async () => {
  const store = await seeded();
  await rejects(putDoc(store, member(), 'posts', 'p1', { ckLeak: true }), 403);
  await rejects(putDoc(store, member(), 'posts', 'p1', { status: 'approved' }), 403);
  await rejects(putDoc(store, admin(), 'posts', 'p1', { status: 'approved' }), 409, 'GATES');
  await putDoc(store, admin(), 'posts', 'p1', { ckLeak: true, ckMedia: true });
  const approved = await putDoc(store, admin(), 'posts', 'p1', { status: 'approved' });
  assert.equal(approved.status, 'approved'); assert.equal(approved.approvedBy, 'user_admin');
  // A member edits the copy: the post drops back to draft and the confirmation is cleared.
  const edited = await putDoc(store, member(), 'posts', 'p1', { body: 'Hello.\n\nChanged.', status: 'draft', ckLeak: false });
  assert.equal(edited.status, 'draft'); assert.equal(edited.ckLeak, false);
  // Unchanged fields in a patch are not edits.
  await putDoc(store, admin(), 'posts', 'p1', { ckLeak: true });
  const same = await putDoc(store, member(), 'posts', 'p1', { body: 'Hello.\n\nChanged.' });
  assert.equal(same.ckLeak, true);
});

test('a blocked term can never be confirmed or approved', async () => {
  const store = await seeded();
  const leaked = await putDoc(store, admin(), 'posts', 'p1', { body: 'Built on Orca.', ckLeak: true, ckMedia: true });
  assert.equal(leaked.ckLeak, false);
  await rejects(putDoc(store, admin(), 'posts', 'p1', { status: 'approved' }), 409, 'GATES');
});

test('unpublished material blocks approval until an admin consents', async () => {
  const store = await seeded();
  const asset = await putDoc(store, member(), 'assets', 'a1', { line: 'agent', name: 'Prototype', consent: 'approved' }).catch(e => e);
  assert.equal(asset.status, 403, 'a member cannot grant consent');
  await putDoc(store, member(), 'assets', 'a1', { line: 'agent', name: 'Prototype' });
  await putDoc(store, admin(), 'posts', 'p1', { assets: ['a1', 'nope'], ckLeak: true, ckMedia: true });
  assert.deepEqual((await store.readDocs('posts')).p1.assets, ['a1']);
  await rejects(putDoc(store, admin(), 'posts', 'p1', { status: 'approved' }), 409, 'GATES');
  await putDoc(store, admin(), 'assets', 'a1', { consent: 'approved' });
  assert.equal((await putDoc(store, admin(), 'posts', 'p1', { status: 'approved' })).status, 'approved');
  // Consent withdrawn later: the stored approval no longer passes the gates.
  await putDoc(store, admin(), 'assets', 'a1', { consent: 'denied' });
  const all = await store.readAll();
  assert.equal(gatesPass(evalGates(all.posts.p1, { terms: all.brands.agent.terms, asset: id => all.assets[id], signal: id => all.signals[id] })), false);
  await rejects(putDoc(store, admin(), 'posts', 'p1', { status: 'published' }), 409, 'GATES');
});

test('borrowed trends must be checked; published posts are locked', async () => {
  const store = await seeded();
  await putDoc(store, member(), 'signals', 's1', { week: '2026-11-16', line: 'agent', kind: 'trend', title: 'Something happened' });
  await putDoc(store, admin(), 'posts', 'p1', { signals: ['s1'], ckLeak: true, ckMedia: true });
  await rejects(putDoc(store, admin(), 'posts', 'p1', { status: 'approved' }), 409, 'GATES');
  await putDoc(store, admin(), 'posts', 'p1', { ckFacts: true });
  await putDoc(store, admin(), 'posts', 'p1', { status: 'approved' });
  const live = await putDoc(store, admin(), 'posts', 'p1', { status: 'published', url: 'https://example.com/p/1' });
  assert.equal(live.status, 'published'); assert.equal(live.publishedVia, 'manual'); assert.equal(live.url, 'https://example.com/p/1');
  await rejects(putDoc(store, admin(), 'posts', 'p1', { body: 'rewrite' }), 409, 'LOCKED');
  await rejects(deleteDoc(store, member(), 'posts', 'p1'), 403);
  assert.equal((await putDoc(store, admin(), 'posts', 'p1', { status: 'approved' })).status, 'approved');
});

test('names every object inherits are never mistaken for stored documents or valid choices', async () => {
  const store = await seeded();
  // "constructor" exists on every plain object; it must behave like any other unknown id.
  await rejects(putDoc(store, member(), 'posts', 'constructor', { body: 'x' }), 400);
  await rejects(putDoc(store, member(), 'posts', 'p9', { ...draft(), line: 'constructor' }), 400);
  await rejects(putDoc(store, member(), 'posts', 'p9', { ...draft(), line: 'toString' }), 400);
  const made = await putDoc(store, member(), 'posts', 'toString', draft());
  assert.equal(made.line, 'agent', 'a legal id that happens to be an inherited name is created like any other');
  assert.deepEqual((await deleteDoc(store, admin(), 'posts', 'valueOf')), { ok: true });
  assert.deepEqual(Object.keys(await store.readDocs('posts')).sort(), ['p1', 'toString']);
  // A made-up format must not switch off the "finished media was looked at" confirmation.
  await rejects(putDoc(store, member(), 'posts', 'p1', { format: 'constructor' }), 400);
  await rejects(putDoc(store, member(), 'posts', 'p1', { format: 'toString' }), 400);
  assert.equal(evalGates({ format: 'constructor', ckLeak: true }, { terms: [], asset: () => null, signal: () => null })[2].ok, false);
  await putDoc(store, member(), 'posts', 'p1', { assets: ['constructor', 'hasOwnProperty'], signals: ['valueOf'] });
  const p1 = (await store.readDocs('posts')).p1;
  assert.deepEqual(p1.assets, []); assert.deepEqual(p1.signals, []);
});

test('consent covers the material as described; a trend stays a trend', async () => {
  const store = await seeded();
  await putDoc(store, member(), 'assets', 'a1', { line: 'agent', name: 'Street scene', where: 'repo/art/street.webp' });
  await putDoc(store, admin(), 'assets', 'a1', { consent: 'approved' });
  await putDoc(store, member(), 'assets', 'a1', { desc: 'A note about it' });
  assert.equal((await store.readDocs('assets')).a1.consent, 'approved', 'a note does not change what was agreed to');
  const swapped = await putDoc(store, member(), 'assets', 'a1', { where: 'repo/art/unreleased-boss.webp' });
  assert.equal(swapped.consent, 'pending', 'pointing the entry at something else starts the decision over');
  assert.equal(swapped.decidedBy, undefined);
  await putDoc(store, admin(), 'assets', 'a1', { consent: 'approved' });
  assert.equal((await putDoc(store, member(), 'assets', 'a1', { name: 'Final boss' })).consent, 'pending');
  assert.equal((await putDoc(store, admin(), 'assets', 'a1', { name: 'Street scene v2', consent: 'approved' })).consent, 'approved', 'an admin can rename and decide in one step');

  await putDoc(store, member(), 'signals', 's1', { week: '2026-11-16', line: 'agent', kind: 'trend', title: 'Someone shipped something' });
  await putDoc(store, admin(), 'posts', 'p1', { signals: ['s1'], ckLeak: true, ckMedia: true });
  assert.equal((await putDoc(store, member(), 'signals', 's1', { kind: 'repo', angle: 'ours is different' })).kind, 'trend', 'relabelling cannot skip the fact check');
  await rejects(putDoc(store, admin(), 'posts', 'p1', { status: 'approved' }), 409, 'GATES');
  await rejects(deleteDoc(store, member(), 'signals', 's1'), 403);
  await putDoc(store, member(), 'signals', 's2', { week: '2026-11-16', line: 'agent', title: 'Unused note' });
  assert.deepEqual(await deleteDoc(store, member(), 'signals', 's2'), { ok: true }, 'a member can remove an entry nothing relies on');
  await deleteDoc(store, admin(), 'signals', 's1');
  assert.deepEqual((await store.readDocs('posts')).p1.signals, [], 'removing it also unlinks it');
});

test('deleting a line with content is refused; deleting an asset unlinks it', async () => {
  const store = await seeded();
  await putDoc(store, member(), 'assets', 'a1', { line: 'agent', name: 'Shot' });
  await putDoc(store, member(), 'posts', 'p1', { assets: ['a1'] });
  await rejects(deleteDoc(store, admin(), 'brands', 'agent'), 409, 'IN_USE');
  await rejects(deleteDoc(store, member(), 'assets', 'a1'), 403);
  await deleteDoc(store, admin(), 'assets', 'a1');
  assert.deepEqual((await store.readDocs('posts')).p1.assets, []);
});

test('tenants never see or touch each other', async () => {
  const backend = memoryBackend();
  const a = tenantStore(backend, 'org_A'), b = tenantStore(backend, 'org_B'), solo = tenantStore(backend, 'user_solo');
  await putDoc(a, admin('org_A'), 'brands', 'agent', brand);
  await putDoc(a, admin('org_A'), 'posts', 'p1', draft());
  const config = settings();
  assert.deepEqual(Object.keys((await getAll(b, admin('org_B'), config)).posts), []);
  assert.deepEqual(Object.keys((await getAll(solo, { userId: 'user_solo', tenantId: 'user_solo', tenantKind: 'user', role: 'admin' }, config)).brands), []);
  // The same ids in another tenant are different documents.
  await rejects(putDoc(b, admin('org_B'), 'posts', 'p1', { body: 'mine now' }), 400);
  await putDoc(b, admin('org_B'), 'brands', 'agent', { name: 'Other' });
  await putDoc(b, admin('org_B'), 'posts', 'p1', { ...draft(), body: 'B body' });
  assert.equal((await a.readDocs('posts')).p1.body, 'Hello.\n\nWorld.');
  assert.equal((await a.readDocs('brands')).agent.name, 'LUMI Agent');
  assert.throws(() => tenantStore(backend, '../org_A'), e => e.status === 400);
  assert.throws(() => tenantStore(backend, 'org_A/../org_B'), e => e.status === 400);
});

test('concurrent saves are retried, not lost', async () => {
  const store = await seeded();
  await Promise.all(Array.from({ length: 5 }, (_, i) => putDoc(store, member(), 'posts', `c${i}`, draft())));
  assert.equal(Object.keys(await store.readDocs('posts')).length, 6);
});

test('importing the old 发布台 export replays approvals through the same rules', async () => {
  const store = fresh();
  const out = await importDesk(store, admin(), {
    brands: { agent: brand },
    assets: { a1: { line: 'agent', name: 'Shot', consent: 'pending' } },
    posts: {
      ok: { ...draft(), status: 'approved', ckLeak: true, ckMedia: true },
      blocked: { ...draft(), assets: ['a1'], status: 'approved', ckLeak: true, ckMedia: true },
      leaky: { ...draft(), body: 'About Orca', status: 'published', ckLeak: true, ckMedia: true },
    },
  });
  assert.equal(out.imported.posts, 3);
  const posts = await store.readDocs('posts');
  assert.equal(posts.ok.status, 'approved');
  assert.equal(posts.blocked.status, 'draft');
  assert.equal(posts.leaky.status, 'draft'); assert.equal(posts.leaky.ckLeak, false);
  await rejects(importDesk(store, member(), {}), 403);
});
