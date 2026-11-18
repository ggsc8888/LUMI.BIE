import { evalGates, formatOf, gatesPass } from '../public/shared/gates.js';
import { requireAdmin } from './auth.js';
import { loadTokens, updateTokens } from './connections.js';
import { audit } from './data.js';
import { HttpError, scrub } from './http.js';
import { readBytes, signedLink } from './media.js';
import { ADAPTERS, PlatformError } from './platforms.js';
import { gateContext } from './schema.js';

const CLAIM_MS = 10 * 60_000;

// Publishing is the one step that cannot be taken back, so everything is re-checked here on the
// server at the moment of publishing, regardless of what the page showed.
export async function publishPost({ store, identity, config, postId, options = {}, fetcher = fetch, budgetMs = 150_000 }) {
  requireAdmin(identity);
  const all = await store.readAll();
  const post = all.posts[postId];
  if (!post) throw new HttpError(404, '这条内容不存在。');
  if (post.status === 'published') throw new HttpError(409, '这条已经发布过了。', 'ALREADY');
  if (post.status !== 'approved') throw new HttpError(409, '要先通过审核，才能发布。', 'NOT_APPROVED');
  const adapter = ADAPTERS[post.platform];
  if (!adapter) throw new HttpError(409, '这个平台需要你手动发布。', 'MANUAL');
  if (!gatesPass(evalGates(post, gateContext(all.brands[post.line], all)))) throw new HttpError(409, '四道确认里有一项已经失效，重新确认后再发。', 'GATES');
  const needsMedia = formatOf(post.format).media;
  if (needsMedia && !post.mediaFile?.path) throw new HttpError(409, '还没有上传成品。', 'NO_MEDIA');
  const loaded = await loadTokens(store, config.secret, post.line, post.platform);
  if (!loaded) throw new HttpError(409, '这个账号还没有连接。', 'NOT_CONNECTED');
  // If the platform never answered last time, the post may already be out. Do not send it twice blindly.
  // A claim that was never released means an earlier attempt died half-way: its outcome is just as unknown.
  const stalled = !!post.publishing && Date.now() - post.publishing >= CLAIM_MS;
  if ((post.publishUncertain || stalled) && !options.force) {
    if (stalled) await store.mutate('posts', docs => { const p = docs[postId]; if (!p?.publishing) return null; p.publishUncertain = p.publishing; delete p.publishing; return { docs }; });
    throw new HttpError(409, '上次发布没有收到平台的确认，可能已经发出去了。请先到平台上核对；确认没有发出去，再点“重试发布”。', 'UNCERTAIN');
  }

  // Renew the token first. Nothing has been sent to the platform yet, so a failure here is safe to retry.
  let tokens = loaded.tokens;
  try {
    const fresh = await adapter.refresh({ config, tokens, fetcher, now: Date.now() });
    if (fresh) { tokens = fresh; await updateTokens(store, config.secret, post.line, post.platform, fresh); }
  } catch (error) {
    if (!(error instanceof PlatformError)) throw error;
    if (error.code === 'NETWORK') throw new HttpError(502, error.message, 'NETWORK');
    throw new HttpError(409, '这个账号的授权已经失效。请到“产品线与账号”里断开，再重新连接。', 'RECONNECT');
  }

  const claimed = await store.mutate('posts', docs => {
    const p = docs[postId];
    if (!p || p.status !== 'approved') throw new HttpError(409, '这条内容刚刚被改过，刷新后再试。', 'CONFLICT');
    if (p.publishing && Date.now() - p.publishing < CLAIM_MS) throw new HttpError(409, '这条正在发布中，稍等一下。', 'BUSY');
    p.publishing = Date.now(); delete p.publishError; delete p.publishUncertain;
    return { docs, result: p };
  });
  const settle = change => store.mutate('posts', docs => { const p = docs[postId]; if (!p) return null; delete p.publishing; change(p); return { docs, result: p }; });

  try {
    const file = claimed.mediaFile;
    const media = file
      ? { type: file.type, size: file.size, url: adapter.needsPublicMedia ? signedLink(config, file.path, 1800) : '',
          bytes: () => readBytes(store, file.path, adapter.maxRelayBytes || 0) }
      : { type: '', size: 0, url: '', bytes: async () => new Uint8Array() };
    const result = await adapter.publish({ config, conn: loaded.conn, tokens, post: claimed, media, fetcher,
      deadline: Date.now() + budgetMs, resume: claimed.pending, options });
    if (result.pending) {
      return { pending: true, post: await settle(p => { p.pending = result.pending; }) };
    }
    const saved = await settle(p => {
      Object.assign(p, { status: 'published', publishedAt: Date.now(), publishedBy: identity.userId, publishedVia: 'native', externalId: result.externalId });
      if (result.url) p.url = result.url;
      delete p.pending; delete p.publishError;
    });
    await audit(store, identity, 'post.published', postId, `${post.platform} ${result.externalId}`);
    return { post: saved };
  } catch (error) {
    const known = error instanceof PlatformError || error instanceof HttpError;
    const message = known ? error.message : '发布时出了问题，稍后再试。';
    if (!known) console.error('[lumi-publish] publish failed:', post.platform, scrub(error?.message));
    await settle(p => {
      p.publishError = { message, at: Date.now() };
      if (!known || error.code === 'NETWORK' || error.code === 'UNCERTAIN') p.publishUncertain = Date.now();
      if (error.code === 'MEDIA') delete p.pending;
    }).catch(() => {});
    throw new HttpError(known && error.status < 500 ? error.status : 502, message, error.code || 'PUBLISH_FAILED');
  }
}
