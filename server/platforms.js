import { scrub } from './http.js';

// One adapter per platform: how to send someone to authorize, how to turn the returned code
// into a long-lived token, and how to publish. Endpoints follow the official docs as read on
// 2026-11-17 (Instagram API with Instagram Login, Pages API + Reels Publishing API, YouTube
// Data API). `fetcher` is injected so tests can run without touching the network.

export class PlatformError extends Error {
  constructor(message, { status = 502, code = 'PLATFORM' } = {}) { super(message); this.status = status; this.code = code; }
}

async function call(fetcher, url, init = {}) {
  let response;
  try { response = await fetcher(url, { ...init, signal: init.signal || AbortSignal.timeout(30_000) }); }
  catch { throw new PlatformError('连不上平台，稍后再试。', { code: 'NETWORK' }); }
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
  if (!response.ok || data?.error) {
    const detail = data?.error?.message || data?.error_description || data?.error_message || (typeof data?.error === 'string' ? data.error : '') || `HTTP ${response.status}`;
    throw new PlatformError(`平台没有接受这次请求：${scrub(detail)}`, { status: 502 });
  }
  return { data: data || {}, headers: response.headers };
}
const getJson = async (fetcher, url, token) => (await call(fetcher, url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).data;
const postJson = async (fetcher, url, token, body) => (await call(fetcher, url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).data;
const postForm = async (fetcher, url, fields) => (await call(fetcher, url, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })).data;
const withQuery = (base, params) => `${base}?${new URLSearchParams(params)}`;
const first = value => (Array.isArray(value?.data) ? value.data[0] : value) || {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const caption = post => [post.body || '', (post.tags || []).join(' ')].filter(Boolean).join('\n\n');
const unsupported = what => new PlatformError(`${what}暂时不支持通过接口发布，请手动发。`, { status: 409, code: 'UNSUPPORTED' });

export const instagram = {
  id: 'instagram', needsPublicMedia: true,
  scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
  authUrl: ({ config, redirectUri, state }) => withQuery('https://www.instagram.com/oauth/authorize', {
    client_id: config.apps.instagram.id, redirect_uri: redirectUri, response_type: 'code', scope: instagram.scopes.join(','), state }),
  async exchange({ config, code, redirectUri, fetcher, now }) {
    const app = config.apps.instagram;
    const short = first(await postForm(fetcher, 'https://api.instagram.com/oauth/access_token', {
      client_id: app.id, client_secret: app.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }));
    const long = await getJson(fetcher, withQuery('https://graph.instagram.com/access_token', {
      grant_type: 'ig_exchange_token', client_secret: app.secret, access_token: short.access_token }));
    const me = first(await getJson(fetcher, `https://graph.instagram.com/${config.graph}/me?fields=user_id,username`, long.access_token));
    const id = String(me.user_id || me.id || short.user_id || '');
    if (!id || !long.access_token) throw new PlatformError('没有拿到 Instagram 账号信息，请重新连接。');
    return { account: { id, name: me.username || id }, tokens: { access: long.access_token, expiresAt: now + (long.expires_in || 5_184_000) * 1000 } };
  },
  // Long-lived tokens last 60 days; refresh once fewer than 10 remain.
  async refresh({ tokens, fetcher, now }) {
    if (!tokens.expiresAt || tokens.expiresAt - now > 10 * 86_400_000) return null;
    const fresh = await getJson(fetcher, withQuery('https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: tokens.access }));
    return { ...tokens, access: fresh.access_token, expiresAt: now + (fresh.expires_in || 5_184_000) * 1000 };
  },
  async publish({ config, conn, tokens, post, media, fetcher, deadline, resume }) {
    const base = `https://graph.instagram.com/${config.graph}`;
    let containerId = resume?.containerId;
    if (!containerId) {
      if (post.format === 'image') {
        if (media.type !== 'image/jpeg') throw new PlatformError('Instagram 的图片只收 JPEG，请换一张 .jpg 再发。', { status: 409, code: 'MEDIA' });
        containerId = (await postJson(fetcher, `${base}/${conn.externalId}/media`, tokens.access, { image_url: media.url, caption: caption(post) })).id;
      } else if (post.format === 'video') {
        if (!media.type.startsWith('video/')) throw new PlatformError('Reels 需要一个视频文件。', { status: 409, code: 'MEDIA' });
        containerId = (await postJson(fetcher, `${base}/${conn.externalId}/media`, tokens.access, { media_type: 'REELS', video_url: media.url, caption: caption(post) })).id;
      } else throw unsupported('这种形式在 Instagram 上');
    }
    for (;;) {
      const status = (await getJson(fetcher, `${base}/${containerId}?fields=status_code`, tokens.access)).status_code;
      if (status === 'FINISHED' || status === 'PUBLISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new PlatformError('Instagram 没能处理这个文件，请检查格式后重新上传。', { status: 409, code: 'MEDIA' });
      if (Date.now() + 6000 > deadline) return { pending: { containerId } };
      await wait(5000);
    }
    const mediaId = (await postJson(fetcher, `${base}/${conn.externalId}/media_publish`, tokens.access, { creation_id: containerId })).id;
    let url = '';
    try { url = (await getJson(fetcher, `${base}/${mediaId}?fields=permalink`, tokens.access)).permalink || ''; } catch { /* the post is live even if the link lookup fails */ }
    return { externalId: String(mediaId), url };
  },
};

export const facebook = {
  id: 'facebook', needsPublicMedia: true,
  scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  authUrl: ({ config, redirectUri, state }) => withQuery(`https://www.facebook.com/${config.graph}/dialog/oauth`, {
    client_id: config.apps.facebook.id, redirect_uri: redirectUri, response_type: 'code', scope: facebook.scopes.join(','), state }),
  async exchange({ config, code, redirectUri, fetcher }) {
    const app = config.apps.facebook, graph = `https://graph.facebook.com/${config.graph}`;
    const short = await getJson(fetcher, withQuery(`${graph}/oauth/access_token`, { client_id: app.id, client_secret: app.secret, redirect_uri: redirectUri, code }));
    const long = await getJson(fetcher, withQuery(`${graph}/oauth/access_token`, {
      grant_type: 'fb_exchange_token', client_id: app.id, client_secret: app.secret, fb_exchange_token: short.access_token }));
    const pages = (await getJson(fetcher, `${graph}/me/accounts?fields=id,name,access_token&limit=100`, long.access_token)).data || [];
    const candidates = pages.filter(p => p.id && p.access_token).map(p => ({ account: { id: String(p.id), name: p.name || String(p.id) }, tokens: { access: p.access_token, expiresAt: 0 } }));
    if (!candidates.length) throw new PlatformError('这个 Facebook 账号下没有可以管理的主页。内容只能发到主页，不能发到个人号。', { status: 409, code: 'NO_PAGE' });
    return candidates.length === 1 ? candidates[0] : { candidates };
  },
  async refresh() { return null; }, // Page tokens derived from a long-lived user token do not expire
  async publish({ config, conn, tokens, post, media, fetcher }) {
    const graph = `https://graph.facebook.com/${config.graph}`, page = conn.externalId, text = caption(post);
    if (post.format === 'text') {
      const id = (await postJson(fetcher, `${graph}/${page}/feed`, tokens.access, { message: text })).id;
      return { externalId: String(id), url: `https://www.facebook.com/${id}` };
    }
    if (post.format === 'image') {
      if (!media.type.startsWith('image/')) throw new PlatformError('这条需要一张图片。', { status: 409, code: 'MEDIA' });
      const out = await postJson(fetcher, `${graph}/${page}/photos`, tokens.access, { url: media.url, caption: text, message: text });
      const id = out.post_id || out.id;
      return { externalId: String(id), url: `https://www.facebook.com/${id}` };
    }
    if (post.format === 'video') {
      if (!media.type.startsWith('video/')) throw new PlatformError('Reels 需要一个视频文件。', { status: 409, code: 'MEDIA' });
      const start = await postJson(fetcher, `${graph}/${page}/video_reels`, tokens.access, { upload_phase: 'start' });
      // The Page token is only ever sent to Meta's own upload host.
      const uploadUrl = /^https:\/\/rupload\.facebook\.com\//.test(start.upload_url || '') ? start.upload_url : `https://rupload.facebook.com/video-upload/${config.graph}/${start.video_id}`;
      await call(fetcher, uploadUrl, {
        method: 'POST', headers: { Authorization: `OAuth ${tokens.access}`, file_url: media.url }, signal: AbortSignal.timeout(120_000) });
      await postJson(fetcher, `${graph}/${page}/video_reels`, tokens.access, {
        video_id: start.video_id, upload_phase: 'finish', video_state: 'PUBLISHED', description: text, ...(post.title ? { title: post.title.slice(0, 100) } : {}) });
      return { externalId: String(start.video_id), url: `https://www.facebook.com/reel/${start.video_id}` };
    }
    throw unsupported('这种形式在 Facebook 上');
  },
};

export const youtube = {
  id: 'youtube', needsPublicMedia: false, maxRelayBytes: 256 * 1024 * 1024,
  scopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
  authUrl: ({ config, redirectUri, state }) => withQuery('https://accounts.google.com/o/oauth2/v2/auth', {
    client_id: config.apps.youtube.id, redirect_uri: redirectUri, response_type: 'code', scope: youtube.scopes.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state }),
  async exchange({ config, code, redirectUri, fetcher, now }) {
    const app = config.apps.youtube;
    const token = await postForm(fetcher, 'https://oauth2.googleapis.com/token', { code, client_id: app.id, client_secret: app.secret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    if (!token.refresh_token) throw new PlatformError('Google 没有给长期授权。请到 Google 账号的“第三方应用”里移除本应用，再重新连接。', { status: 409, code: 'NO_REFRESH' });
    const channel = (await getJson(fetcher, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', token.access_token)).items?.[0];
    if (!channel?.id) throw new PlatformError('这个 Google 账号下没有 YouTube 频道。', { status: 409, code: 'NO_CHANNEL' });
    return { account: { id: channel.id, name: channel.snippet?.title || channel.id },
      tokens: { access: token.access_token, refresh: token.refresh_token, expiresAt: now + (token.expires_in || 3600) * 1000 } };
  },
  async refresh({ config, tokens, fetcher, now }) {
    if (tokens.expiresAt - now > 5 * 60_000) return null;
    const app = config.apps.youtube;
    const fresh = await postForm(fetcher, 'https://oauth2.googleapis.com/token', { client_id: app.id, client_secret: app.secret, refresh_token: tokens.refresh, grant_type: 'refresh_token' });
    return { ...tokens, access: fresh.access_token, expiresAt: now + (fresh.expires_in || 3600) * 1000 };
  },
  async publish({ tokens, post, media, fetcher, options }) {
    if (post.format !== 'video' && post.format !== 'long') throw unsupported('这种形式在 YouTube 上');
    if (!media.type.startsWith('video/')) throw new PlatformError('YouTube 需要一个视频文件。', { status: 409, code: 'MEDIA' });
    const title = (post.title || post.hook || '').replace(/[<>]/g, '').trim().slice(0, 100);
    if (!title) throw new PlatformError('YouTube 需要一个标题。', { status: 409, code: 'MEDIA' });
    const privacyStatus = ['public', 'unlisted', 'private'].includes(options?.visibility) ? options.visibility : 'public';
    const bytes = await media.bytes();
    const init = await call(fetcher, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(bytes.byteLength), 'X-Upload-Content-Type': media.type },
      body: JSON.stringify({
        snippet: { title, description: caption(post).slice(0, 5000), tags: (post.tags || []).map(t => t.replace(/^#/, '')).filter(Boolean).slice(0, 30), categoryId: '22' },
        status: { privacyStatus, selfDeclaredMadeForKids: false } }) });
    const location = init.headers.get('location');
    if (!location || !/^https:\/\/[a-z0-9.-]+\.googleapis\.com\//.test(location)) throw new PlatformError('YouTube 没有返回上传地址。');
    const done = await call(fetcher, location, { method: 'PUT', headers: { 'Content-Type': media.type, 'Content-Length': String(bytes.byteLength) }, body: bytes, signal: AbortSignal.timeout(150_000) });
    if (!done.data.id) throw new PlatformError('YouTube 没有确认上传成功，请到 YouTube 工作室核对后再决定是否重发。', { code: 'UNCERTAIN' });
    return { externalId: done.data.id, url: `https://www.youtube.com/watch?v=${done.data.id}` };
  },
};

export const ADAPTERS = { instagram, facebook, youtube };
export const appConfigured = (config, platform) => !!(config.apps[platform]?.id && config.apps[platform]?.secret);
