import './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import app from '../api/app.js';
import mediaApi from '../api/media.js';
import { createVerifier } from '../server/auth.js';
import { loadTokens, publicView, readConnections, saveConnection } from '../server/connections.js';
import { putDoc } from '../server/data.js';
import { settings } from '../server/env.js';
import { attachMedia, signedLink, uploadTicket } from '../server/media.js';
import { finishConnect, selectChoice, startConnect } from '../server/oauth.js';
import { publishPost } from '../server/publish.js';
import { backendFor, memoryBackend, tenantStore } from '../server/store.js';
import { admin, brand, call, draft, fakeFetch, member } from './helpers.js';

const config = settings();
const rejects = (promise, status, code) => assert.rejects(promise, e => e.status === status && (!code || e.code === code));
const post = (action, body, headers = {}) => call(app, { method: 'POST', url: `/api/app?do=${action}`, headers, body });

// ---------- sign-in ----------
test('Clerk sessions: tenant and role come from the verified token only', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const pk = 'pk_test_' + Buffer.from('clerk.example.com$').toString('base64');
  const env = { CLERK_PUBLISHABLE_KEY: pk, LUMI_PUBLISH_ORIGIN: 'https://publish.example.com', LUMI_PUBLISH_SECRET: 'x'.repeat(40), BLOB_READ_WRITE_TOKEN: 't' };
  const verify = createVerifier({ env, resolveKey: publicKey });
  const now = Math.floor(Date.now() / 1000);
  const token = (claims, opts = {}) => new SignJWT({ azp: 'https://publish.example.com', sid: 'sess_1', ...claims })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(opts.iss || 'https://clerk.example.com').setSubject(claims.sub || 'user_1')
    .setIssuedAt(opts.iat || now).setNotBefore(opts.iat || now).setExpirationTime((opts.iat || now) + 60).sign(opts.key || privateKey);
  const req = t => ({ headers: { 'x-lumi-session': t } });
  assert.deepEqual(await verify(req(await token({ v: 2, o: { id: 'org_9', rol: 'admin', slg: 'lumi' } }))), { userId: 'user_1', tenantId: 'org_9', tenantKind: 'org', role: 'admin' });
  assert.equal((await verify(req(await token({ v: 2, o: { id: 'org_9', rol: 'member' } })))).role, 'member');
  assert.equal((await verify(req(await token({ org_id: 'org_9', org_role: 'org:admin' })))).role, 'admin', 'v1 claims');
  assert.deepEqual(await verify(req(await token({}))), { userId: 'user_1', tenantId: 'user_1', tenantKind: 'user', role: 'admin' });
  const other = await generateKeyPair('RS256');
  for (const bad of [
    await token({ azp: 'https://evil.example.com' }), await token({ sts: 'pending' }), await token({ o: { id: '../org_1' } }),
    await token({}, { iss: 'https://other.example.com' }), await token({}, { key: other.privateKey }), await token({}, { iat: now - 600 }), 'garbage',
  ]) await rejects(verify(req(bad)), 401);
  await rejects(verify({ headers: {} }), 401);
  await rejects(verify({ headers: { 'x-lumi-session': await token({}), origin: 'https://evil.example.com' } }), 403);
  // A dev header means nothing once real sign-in is configured.
  await rejects(verify({ headers: { 'x-dev-user': 'user_x', 'x-dev-org': 'org_9' } }), 401);
  assert.equal(settings({ ...env, LUMI_DEV_AUTH: '1', VERCEL: '1' }).dev, false);
  // An allow-list narrows who gets in: a listed person, or anyone working inside a listed organization.
  const gated = allow => createVerifier({ env: { ...env, LUMI_PUBLISH_ALLOW: allow }, resolveKey: publicKey });
  assert.equal((await gated('user_1')(req(await token({})))).tenantId, 'user_1');
  assert.equal((await gated('org_9, user_other')(req(await token({ v: 2, o: { id: 'org_9', rol: 'member' } })))).tenantId, 'org_9');
  await assert.rejects(gated('org_9')(req(await token({}))), e => e.status === 403 && e.code === 'NOT_INVITED', 'own personal space is not the listed organization');
  await assert.rejects(gated('user_2')(req(await token({ v: 2, o: { id: 'org_9', rol: 'admin' } }))), e => e.code === 'NOT_INVITED');
  await assert.rejects(gated('nonsense !!')(req(await token({}))), e => e.code === 'NOT_INVITED', 'an unreadable list admits nobody');
  await rejects(gated('user_1')(req('garbage')), 401);
  assert.ok((await exportJWK(publicKey)).n);
});

// ---------- API surface ----------
test('API: each organization gets its own data; members cannot do admin steps', async () => {
  const A = { 'x-dev-org': 'org_ApiA' }, B = { 'x-dev-org': 'org_ApiB' }, Am = { ...A, 'x-dev-role': 'member', 'x-dev-user': 'user_m' };
  assert.equal((await post('doc-put', { coll: 'brands', id: 'agent', patch: brand }, A)).status, 200);
  assert.equal((await post('doc-put', { coll: 'posts', id: 'p1', patch: draft() }, Am)).status, 200);
  const dataA = (await call(app, { url: '/api/app?do=data', headers: A })).json;
  assert.deepEqual(Object.keys(dataA.posts), ['p1']); assert.equal(dataA.tenant.id, 'org_ApiA'); assert.equal(dataA.me.role, 'admin');
  const dataB = (await call(app, { url: '/api/app?do=data', headers: B })).json;
  assert.deepEqual(dataB.posts, {}); assert.deepEqual(dataB.brands, {});
  // A tenant id in the body is ignored: the session decides.
  await post('doc-put', { coll: 'brands', id: 'x', patch: { name: 'X' }, tenantId: 'org_ApiA', tenant: 'org_ApiA' }, B);
  assert.equal((await call(app, { url: '/api/app?do=data', headers: A })).json.brands.x, undefined);
  assert.equal((await post('doc-put', { coll: 'posts', id: 'p1', patch: { ckLeak: true } }, Am)).status, 403);
  assert.equal((await post('connect-start', { brand: 'agent', platform: 'instagram' }, Am)).status, 403);
  assert.equal((await post('publish', { id: 'p1' }, Am)).status, 403);
  assert.equal((await post('import', {}, Am)).status, 403);
  assert.equal((await post('doc-put', { coll: 'secrets', id: 'a', patch: {} }, A)).status, 400);
  assert.equal((await post('nope', {}, A)).status, 404);
  const pub = (await call(app, { url: '/api/app?do=config' })).json;
  assert.deepEqual(Object.keys(pub).sort(), ['configured', 'dev', 'issuer', 'missing', 'publishableKey']);
});

// ---------- connecting accounts ----------
async function tenant(name) {
  const store = tenantStore(backendFor(), name);
  await putDoc(store, admin(name), 'brands', 'agent', brand);
  return store;
}
const igRules = [
  ['api.instagram.com/oauth/access_token', { data: [{ access_token: 'IG_SHORT', user_id: '1789', permissions: 'instagram_business_basic' }] }],
  ['graph.instagram.com/access_token', { access_token: 'IG_LONG_TOKEN', token_type: 'bearer', expires_in: 5183944 }],
  ['/me?fields=user_id,username', { user_id: '1789', username: 'lumi.agent' }],
];

test('connect: state is sealed, bound to the browser, and the token is stored sealed', async () => {
  const store = await tenant('org_Conn');
  await rejects(startConnect({ store, identity: member('org_Conn'), config, brand: 'agent', platform: 'instagram' }), 403);
  await rejects(startConnect({ store, identity: admin('org_Conn'), config, brand: 'agent', platform: 'tiktok' }), 400);
  await rejects(startConnect({ store, identity: admin('org_Conn'), config, brand: 'nope', platform: 'instagram' }), 404);
  const { url, setCookie } = await startConnect({ store, identity: admin('org_Conn'), config, brand: 'agent', platform: 'instagram' });
  const auth = new URL(url);
  assert.equal(auth.origin + auth.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:4173/api/callback/instagram');
  assert.equal(auth.searchParams.get('scope'), 'instagram_business_basic,instagram_business_content_publish');
  const state = auth.searchParams.get('state'), cookie = setCookie.split(';')[0];
  assert.match(setCookie, /HttpOnly; SameSite=Lax/);
  const finish = (params, cookieHeader, platform = 'instagram', fetcher = fakeFetch(igRules)) => finishConnect({
    request: { headers: { cookie: cookieHeader } }, params: new URLSearchParams(params), config, platform, env: process.env, fetcher });
  // No cookie, wrong cookie, wrong platform, tampered state, denied by the user.
  assert.match((await finish({ state, code: 'c' }, '')).location, /connect=expired/);
  assert.match((await finish({ state, code: 'c' }, 'lumi-dev-oauth=someone-else')).location, /connect=expired/);
  assert.match((await finish({ state, code: 'c' }, cookie, 'facebook')).location, /connect=expired/);
  assert.match((await finish({ state: state.slice(0, -3) + 'abc', code: 'c' }, cookie)).location, /connect=expired/);
  assert.match((await finish({ state, error: 'access_denied' }, cookie)).location, /connect=denied/);
  assert.deepEqual(Object.keys(await readConnections(store)), []);
  const fetcher = fakeFetch(igRules);
  const done = await finish({ state, code: 'the-code' }, cookie, 'instagram', fetcher);
  assert.equal(done.location, 'http://localhost:4173/?connect=ok&platform=instagram#accounts');
  assert.match(fetcher.calls[0].body, /code=the-code/); assert.match(fetcher.calls[0].body, /client_secret=ig-secret/);
  const view = publicView(await readConnections(store));
  assert.deepEqual(Object.keys(view), ['agent_instagram']);
  assert.equal(view.agent_instagram.name, 'lumi.agent'); assert.equal(view.agent_instagram.status, 'connected');
  assert.ok(!JSON.stringify(view).includes('IG_LONG_TOKEN'));
  // At rest the token is ciphertext, and another tenant's key cannot open it.
  const rawStored = JSON.stringify([...store.backend.files], null, 0) + JSON.stringify(await store.backend.read(`${store.base}/state.json`));
  assert.ok(!rawStored.includes('IG_LONG_TOKEN'));
  assert.equal((await loadTokens(store, config.secret, 'agent', 'instagram')).tokens.access, 'IG_LONG_TOKEN');
  const elsewhere = tenantStore(store.backend, 'org_Other');
  await elsewhere.backend.write(`${elsewhere.base}/state.json`, (await store.backend.read(`${store.base}/state.json`)).value, null);
  assert.equal(await loadTokens(elsewhere, config.secret, 'agent', 'instagram'), null);
});

test('connect: a Facebook login with several Pages waits for an admin to pick one', async () => {
  const store = await tenant('org_Fb');
  const { url, setCookie } = await startConnect({ store, identity: admin('org_Fb'), config, brand: 'agent', platform: 'facebook' });
  const fetcher = fakeFetch([
    [u => u.includes('/oauth/access_token') && u.includes('fb_exchange_token'), { access_token: 'FB_LONG' }],
    ['/oauth/access_token', { access_token: 'FB_SHORT' }],
    ['/me/accounts', { data: [{ id: '11', name: 'LUMI Agent', access_token: 'PAGE_11' }, { id: '22', name: 'LUMI Build', access_token: 'PAGE_22' }] }],
  ]);
  const out = await finishConnect({ request: { headers: { cookie: setCookie.split(';')[0] } },
    params: new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'c' }), config, platform: 'facebook', env: process.env, fetcher });
  assert.match(out.location, /connect=pick/);
  let view = publicView(await readConnections(store)).agent_facebook;
  assert.equal(view.status, 'pick'); assert.deepEqual(view.choices, [{ id: '11', name: 'LUMI Agent' }, { id: '22', name: 'LUMI Build' }]);
  assert.equal(await loadTokens(store, config.secret, 'agent', 'facebook'), null);
  await rejects(selectChoice({ store, identity: member('org_Fb'), config, brand: 'agent', platform: 'facebook', id: '11' }), 403);
  await rejects(selectChoice({ store, identity: admin('org_Fb'), config, brand: 'agent', platform: 'facebook', id: '99' }), 404);
  await selectChoice({ store, identity: admin('org_Fb'), config, brand: 'agent', platform: 'facebook', id: '11' });
  const loaded = await loadTokens(store, config.secret, 'agent', 'facebook');
  assert.equal(loaded.conn.externalId, '11'); assert.equal(loaded.tokens.access, 'PAGE_11');
  assert.ok(!JSON.stringify(await store.backend.read(`${store.base}/state.json`)).includes('PAGE_22'));
});

// ---------- media + publishing ----------
async function ready(name, platform = 'instagram', format = 'image', type = 'image/jpeg') {
  const store = await tenant(name), who = admin(name);
  await putDoc(store, who, 'posts', 'p1', { ...draft(), platform, format });
  await saveConnection(store, config.secret, { brand: 'agent', platform, account: { id: 'ACC1', name: 'acct' },
    tokens: { access: 'TOKEN_1', refresh: 'REFRESH_1', expiresAt: Date.now() + 40 * 86_400_000 }, userId: who.userId, now: Date.now() });
  const ticket = await uploadTicket({ store, postId: 'p1', name: '成品 final.jpg', type, size: 4 });
  store.backend.putFile(ticket.pathname, Buffer.from([1, 2, 3, 4]), type);
  await attachMedia({ store, identity: who, postId: 'p1', pathname: ticket.pathname, name: 'final.jpg' });
  await putDoc(store, who, 'posts', 'p1', { ckLeak: true, ckMedia: true });
  await putDoc(store, who, 'posts', 'p1', { status: 'approved' });
  return { store, who };
}

test('media: uploads are checked, new media resets approval, links are signed and expire', async () => {
  const { store, who } = await ready('org_Media');
  await rejects(uploadTicket({ store, postId: 'p1', name: 'a.exe', type: 'application/x-msdownload', size: 4 }), 400);
  await rejects(uploadTicket({ store, postId: 'p1', name: 'a.mp4', type: 'video/mp4', size: 6e8 }), 400);
  await rejects(attachMedia({ store, identity: who, postId: 'p1', pathname: 'lumi-publish/v1/org_Other/media/p1/x.jpg' }), 400);
  const again = await uploadTicket({ store, postId: 'p1', name: 'v2.jpg', type: 'image/jpeg', size: 3 });
  assert.match(again.pathname, /^lumi-publish\/v1\/org_Media\/media\/p1\/[\w-]+-v2\.jpg$/);
  await rejects(attachMedia({ store, identity: who, postId: 'p1', pathname: again.pathname }), 404);
  const old = (await store.readDocs('posts')).p1.mediaFile.path;
  store.backend.putFile(again.pathname, Buffer.from([9, 9, 9]), 'image/jpeg');
  const swapped = await attachMedia({ store, identity: member('org_Media'), postId: 'p1', pathname: again.pathname, name: 'v2.jpg' });
  assert.equal(swapped.status, 'draft'); assert.equal(swapped.ckMedia, false); assert.equal(store.backend.files.has(old), false);
  const link = new URL(signedLink(config, again.pathname, 60));
  const fetched = await call(mediaApi, { url: link.pathname + link.search, method: 'HEAD', headers: {} });
  assert.equal(fetched.status, 200); assert.equal(fetched.headers['content-type'], 'image/jpeg'); assert.equal(fetched.headers['content-length'], '3');
  const tampered = new URL(link); tampered.searchParams.set('p', Buffer.from(old).toString('base64url'));
  assert.equal((await call(mediaApi, { url: tampered.pathname + tampered.search, headers: {} })).status, 403);
  const expired = new URL(signedLink(config, again.pathname, -1));
  assert.equal((await call(mediaApi, { url: expired.pathname + expired.search, headers: {} })).status, 403);
});

const igPublish = (extra = []) => fakeFetch([...extra,
  [(u, i) => u.endsWith('/ACC1/media') && i.method === 'POST', { id: 'CONTAINER_1' }],
  ['CONTAINER_1?fields=status_code', { status_code: 'FINISHED' }],
  [(u, i) => u.endsWith('/ACC1/media_publish') && i.method === 'POST', { id: 'MEDIA_9' }],
  ['MEDIA_9?fields=permalink', { permalink: 'https://www.instagram.com/p/abc/' }],
]);

test('publish: re-checks everything on the server, then posts once', async () => {
  const { store, who } = await ready('org_Pub');
  await rejects(publishPost({ store, identity: member('org_Pub'), config, postId: 'p1', fetcher: igPublish() }), 403);
  const fetcher = igPublish();
  const out = await publishPost({ store, identity: who, config, postId: 'p1', fetcher });
  assert.equal(out.post.status, 'published'); assert.equal(out.post.publishedVia, 'native');
  assert.equal(out.post.externalId, 'MEDIA_9'); assert.equal(out.post.url, 'https://www.instagram.com/p/abc/');
  const create = fetcher.calls[0], sent = JSON.parse(create.body);
  assert.equal(create.url, 'https://graph.instagram.com/v27.0/ACC1/media'); assert.equal(create.headers.Authorization, 'Bearer TOKEN_1');
  assert.equal(sent.caption, 'Hello.\n\nWorld.\n\n#LUMI');
  assert.match(sent.image_url, /^http:\/\/localhost:4173\/api\/media\?p=[\w-]+&e=\d+&s=[\w-]+$/);
  assert.ok(!fetcher.calls.some(c => c.url.includes('TOKEN_1')), 'tokens never go in URLs');
  assert.equal(JSON.parse(fetcher.calls[2].body).creation_id, 'CONTAINER_1');
  await rejects(publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish() }), 409, 'ALREADY');
  await rejects(putDoc(store, who, 'posts', 'p1', { status: 'approved' }), 409, 'LOCKED');
});

test('publish: refuses when a confirmation went stale, nothing is connected, or media is missing', async () => {
  const { store, who } = await ready('org_Stale');
  await putDoc(store, who, 'brands', 'agent', { terms: [...brand.terms, 'World'] }); // the approved copy now contains a blocked term
  await rejects(publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish() }), 409, 'GATES');
  const draftOnly = await tenant('org_Draft');
  await putDoc(draftOnly, admin('org_Draft'), 'posts', 'p1', draft());
  await rejects(publishPost({ store: draftOnly, identity: admin('org_Draft'), config, postId: 'p1', fetcher: igPublish() }), 409, 'NOT_APPROVED');
  const manual = await tenant('org_Manual');
  await putDoc(manual, admin('org_Manual'), 'posts', 'p1', { ...draft(), platform: 'xiaohongshu', format: 'text', ckLeak: true });
  await putDoc(manual, admin('org_Manual'), 'posts', 'p1', { status: 'approved' });
  await rejects(publishPost({ store: manual, identity: admin('org_Manual'), config, postId: 'p1', fetcher: igPublish() }), 409, 'MANUAL');
  const nomedia = await tenant('org_NoMedia');
  await putDoc(nomedia, admin('org_NoMedia'), 'posts', 'p1', { ...draft(), ckLeak: true, ckMedia: true });
  await putDoc(nomedia, admin('org_NoMedia'), 'posts', 'p1', { status: 'approved' });
  await rejects(publishPost({ store: nomedia, identity: admin('org_NoMedia'), config, postId: 'p1', fetcher: igPublish() }), 409, 'NO_MEDIA');
});

test('publish: if the platform never answers, a retry is blocked until someone checks', async () => {
  const { store, who } = await ready('org_Net');
  const dead = fakeFetch([[() => true, new Error('socket hang up')]]);
  await rejects(publishPost({ store, identity: who, config, postId: 'p1', fetcher: dead }), 502, 'NETWORK');
  const after = (await store.readDocs('posts')).p1;
  assert.equal(after.status, 'approved'); assert.ok(after.publishUncertain); assert.equal(after.publishing, undefined);
  await rejects(publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish() }), 409, 'UNCERTAIN');
  const out = await publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish(), options: { force: true } });
  assert.equal(out.post.status, 'published');
});

test('publish: an attempt that died half-way counts as unknown; a revoked authorization asks to reconnect', async () => {
  const { store, who } = await ready('org_Stalled');
  await store.mutate('posts', docs => { docs.p1.publishing = Date.now() - 11 * 60_000; return { docs }; });
  await rejects(publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish() }), 409, 'UNCERTAIN');
  const flagged = (await store.readDocs('posts')).p1;
  assert.ok(flagged.publishUncertain); assert.equal(flagged.publishing, undefined); assert.equal(flagged.status, 'approved');
  assert.equal((await publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish(), options: { force: true } })).post.status, 'published');
  const busy = await ready('org_Busy');
  await busy.store.mutate('posts', docs => { docs.p1.publishing = Date.now() - 5000; return { docs }; });
  await rejects(publishPost({ store: busy.store, identity: busy.who, config, postId: 'p1', fetcher: igPublish() }), 409, 'BUSY');

  const yt = await ready('org_Revoked', 'youtube', 'video', 'video/mp4');
  await saveConnection(yt.store, config.secret, { brand: 'agent', platform: 'youtube', account: { id: 'UC1', name: 'chan' },
    tokens: { access: 'OLD', refresh: 'GONE', expiresAt: Date.now() - 1000 }, userId: yt.who.userId, now: Date.now() });
  const revoked = fakeFetch([['oauth2.googleapis.com/token', { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }]]);
  await rejects(publishPost({ store: yt.store, identity: yt.who, config, postId: 'p1', fetcher: revoked }), 409, 'RECONNECT');
  const untouched = (await yt.store.readDocs('posts')).p1;
  assert.equal(untouched.publishUncertain, undefined); assert.equal(untouched.publishing, undefined); assert.equal(revoked.calls.length, 1, 'nothing was sent to YouTube');
  await saveConnection(yt.store, config.secret, { brand: 'agent', platform: 'youtube', account: { id: 'UC1', name: 'chan' },
    tokens: { access: 'GOOD', refresh: 'R', expiresAt: Date.now() + 3_000_000 }, userId: yt.who.userId, now: Date.now() });
  const silent = fakeFetch([['uploadType=resumable', { body: {}, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U2' } }], ['upload_id=U2', {}]]);
  await rejects(publishPost({ store: yt.store, identity: yt.who, config, postId: 'p1', fetcher: silent }), 502, 'UNCERTAIN');
  assert.ok((await yt.store.readDocs('posts')).p1.publishUncertain, 'an upload YouTube did not confirm is not retried blindly');
});

test('publish: a platform refusal is shown without leaking the token, and can simply be retried', async () => {
  const { store, who } = await ready('org_Refuse');
  const refuse = fakeFetch([[() => true, { status: 400, body: { error: { message: 'Invalid OAuth access_token=TOKEN_1 for user' } } }]]);
  const error = await publishPost({ store, identity: who, config, postId: 'p1', fetcher: refuse }).catch(e => e);
  assert.equal(error.status, 502); assert.ok(!error.message.includes('TOKEN_1'));
  const after = (await store.readDocs('posts')).p1;
  assert.ok(after.publishError.message); assert.equal(after.publishUncertain, undefined);
  assert.equal((await publishPost({ store, identity: who, config, postId: 'p1', fetcher: igPublish() })).post.status, 'published');
});

test('publish: Instagram only takes JPEG; a slow container resumes instead of duplicating', async () => {
  const png = await ready('org_Png', 'instagram', 'image', 'image/png');
  await rejects(publishPost({ store: png.store, identity: png.who, config, postId: 'p1', fetcher: igPublish() }), 409, 'MEDIA');
  const { store, who } = await ready('org_Slow', 'instagram', 'video', 'video/mp4');
  const slow = fakeFetch([[(u, i) => u.endsWith('/ACC1/media') && i.method === 'POST', { id: 'CONTAINER_1' }], ['CONTAINER_1?fields=status_code', { status_code: 'IN_PROGRESS' }]]);
  const first = await publishPost({ store, identity: who, config, postId: 'p1', fetcher: slow, budgetMs: 0 });
  assert.equal(first.pending, true); assert.equal(first.post.status, 'approved'); assert.deepEqual(first.post.pending, { containerId: 'CONTAINER_1' });
  assert.equal(JSON.parse(slow.calls[0].body).media_type, 'REELS');
  const resume = igPublish();
  const second = await publishPost({ store, identity: who, config, postId: 'p1', fetcher: resume });
  assert.equal(second.post.status, 'published');
  assert.ok(!resume.calls.some(c => c.url.endsWith('/ACC1/media')), 'no second container');
});

test('publish: Facebook Page reel and YouTube upload follow the documented calls', async () => {
  const fb = await ready('org_FbPub', 'facebook', 'video', 'video/mp4');
  const fbFetch = fakeFetch([
    [(u, i) => u.endsWith('/ACC1/video_reels') && JSON.parse(i.body).upload_phase === 'start', { video_id: 'V7', upload_url: 'https://evil.example.com/steal' }],
    ['rupload.facebook.com/video-upload/v27.0/V7', { success: true }],
    [(u, i) => u.endsWith('/ACC1/video_reels') && JSON.parse(i.body).upload_phase === 'finish', { success: true }],
  ]);
  const fbOut = await publishPost({ store: fb.store, identity: fb.who, config, postId: 'p1', fetcher: fbFetch });
  assert.equal(fbOut.post.url, 'https://www.facebook.com/reel/V7');
  assert.equal(fbFetch.calls[1].headers.Authorization, 'OAuth TOKEN_1'); assert.match(fbFetch.calls[1].headers.file_url, /\/api\/media\?p=/);
  assert.ok(!fbFetch.calls.some(c => c.url.includes('evil.example.com')), 'the token only goes to Meta upload host');
  assert.equal(JSON.parse(fbFetch.calls[2].body).video_state, 'PUBLISHED');

  const yt = await ready('org_Yt', 'youtube', 'video', 'video/mp4');
  await saveConnection(yt.store, config.secret, { brand: 'agent', platform: 'youtube', account: { id: 'UC1', name: 'chan' },
    tokens: { access: 'OLD', refresh: 'REFRESH_1', expiresAt: Date.now() - 1000 }, userId: yt.who.userId, now: Date.now() });
  const ytFetch = fakeFetch([
    ['oauth2.googleapis.com/token', { access_token: 'NEW_ACCESS', expires_in: 3599 }],
    ['uploadType=resumable', { body: {}, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' } }],
    ['upload_id=U1', { id: 'vid123' }],
  ]);
  const ytOut = await publishPost({ store: yt.store, identity: yt.who, config, postId: 'p1', fetcher: ytFetch, options: { visibility: 'unlisted' } });
  assert.equal(ytOut.post.url, 'https://www.youtube.com/watch?v=vid123');
  assert.match(ytFetch.calls[0].body, /grant_type=refresh_token/);
  const meta = JSON.parse(ytFetch.calls[1].body);
  assert.equal(ytFetch.calls[1].headers.Authorization, 'Bearer NEW_ACCESS'); assert.equal(meta.status.privacyStatus, 'unlisted');
  assert.equal(meta.snippet.title, 'Hi'); assert.deepEqual(meta.snippet.tags, ['LUMI']);
  assert.equal(ytFetch.calls[2].method, 'PUT'); assert.equal(ytFetch.calls[2].body.byteLength, 4);
  assert.equal((await loadTokens(yt.store, config.secret, 'agent', 'youtube')).tokens.access, 'NEW_ACCESS', 'refreshed token is saved');
});
