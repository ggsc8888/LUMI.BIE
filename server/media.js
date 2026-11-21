import { Readable } from 'node:stream';
import { nonce, sameText, sign } from './crypto.js';
import { HttpError, send } from './http.js';
import { backendFor } from './store.js';

// Finished images and videos are kept in the private store. A platform that has to fetch the
// file itself (Instagram, Facebook) gets a signed link that stops working after a few minutes.

export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const prefixOf = (store, postId) => `${store.base}/media/${postId}/`;

function editablePost(docs, postId) {
  const post = docs[postId];
  if (!post) throw new HttpError(404, '这条内容不存在。');
  if (post.status === 'published') throw new HttpError(409, '已发布的内容不能再换成品。', 'LOCKED');
  return post;
}

export async function uploadTicket({ store, postId, name, type, size }) {
  editablePost(await store.readDocs('posts'), postId);
  if (!MEDIA_TYPES.includes(type)) throw new HttpError(400, '只支持 JPEG、PNG、WebP 图片和 MP4、MOV 视频。');
  if (!(Number(size) > 0 && Number(size) <= MAX_MEDIA_BYTES)) throw new HttpError(400, '文件太大了，上限是 500 MB。');
  const safe = String(name || 'file').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-60) || 'file';
  const pathname = `${prefixOf(store, postId)}${nonce(9)}-${safe}`;
  if (!store.backend.uploadToken) return { mode: 'dev', pathname };
  return { mode: 'blob', pathname, token: await store.backend.uploadToken(pathname, { maxBytes: MAX_MEDIA_BYTES, types: [type] }) };
}

export async function attachMedia({ store, identity, postId, pathname, name }) {
  if (typeof pathname !== 'string' || !pathname.startsWith(prefixOf(store, postId)) || pathname.includes('..')) throw new HttpError(400, '文件位置无效。');
  const stat = await store.backend.stat(pathname);
  if (!stat) throw new HttpError(404, '上传没有完成，请重试。');
  if (!MEDIA_TYPES.includes(stat.type) || stat.size > MAX_MEDIA_BYTES) {
    await store.backend.remove(pathname).catch(() => {});
    throw new HttpError(400, '这个文件的格式或大小不符合要求。');
  }
  const { post, old } = await store.mutate('posts', docs => {
    const target = editablePost(docs, postId), previous = target.mediaFile?.path;
    target.mediaFile = { path: pathname, name: String(name || '').slice(0, 120), type: stat.type, size: stat.size, at: Date.now(), by: identity.userId };
    // New media has not been looked at yet: the "I have seen it" confirmation and any approval reset.
    target.ckMedia = false;
    if (target.status === 'approved') target.status = 'draft';
    delete target.pending; delete target.publishError; delete target.publishUncertain;
    return { docs, result: { post: target, old: previous } };
  });
  if (old && old !== pathname) await store.backend.remove(old).catch(() => {});
  return post;
}

export async function removeMedia({ store, postId }) {
  const { post, old } = await store.mutate('posts', docs => {
    const target = editablePost(docs, postId), previous = target.mediaFile?.path;
    delete target.mediaFile; delete target.pending;
    target.ckMedia = false;
    if (target.status === 'approved') target.status = 'draft';
    return { docs, result: { post: target, old: previous } };
  });
  if (old) await store.backend.remove(old).catch(() => {});
  return post;
}

export function signedLink(config, path, seconds) {
  const expires = Date.now() + seconds * 1000, p = Buffer.from(path).toString('base64url');
  return `${config.origin}/api/media?p=${p}&e=${expires}&s=${sign(config.secret, 'media-link', `${p}.${expires}`)}`;
}

export async function previewLink({ store, config, postId }) {
  const post = (await store.readDocs('posts'))[postId];
  if (!post?.mediaFile?.path) throw new HttpError(404, '这条内容还没有成品。');
  return { url: signedLink(config, post.mediaFile.path, 600), type: post.mediaFile.type };
}

// Unauthenticated on purpose (the platform's fetcher has no session); the signature is the access check.
export async function serveSigned({ request, response, params, config, env }) {
  const p = params.get('p') || '', expires = Number(params.get('e'));
  if (!p || !Number.isFinite(expires) || expires < Date.now() || !sameText(params.get('s') || '', sign(config.secret, 'media-link', `${p}.${expires}`))) {
    return send(response, 403, { error: '链接已失效。' });
  }
  const path = Buffer.from(p, 'base64url').toString();
  if (!/^lumi-publish\/v1\/(org|user)_[A-Za-z0-9]+\/media\//.test(path) || path.includes('..')) return send(response, 403, { error: '链接已失效。' });
  const file = await backendFor(env).stream(path);
  if (!file) return send(response, 404, { error: '文件不存在。' });
  response.statusCode = 200;
  response.setHeader('Content-Type', file.type);
  if (file.size) response.setHeader('Content-Length', String(file.size));
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Disposition', 'inline');
  if (request.method === 'HEAD') { await file.stream.cancel().catch(() => {}); return response.end(); }
  Readable.fromWeb(file.stream).pipe(response);
}

export async function readBytes(store, path, limit) {
  const file = await store.backend.stream(path);
  if (!file) throw new HttpError(404, '成品文件找不到了，请重新上传。');
  if (file.size > limit) { await file.stream.cancel().catch(() => {}); throw new HttpError(409, '这个文件太大，接口转发不了，请手动上传到平台。', 'MEDIA'); }
  return new Uint8Array(await new Response(file.stream).arrayBuffer());
}
