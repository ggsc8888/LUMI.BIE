import { NATIVE_PLATFORMS } from '../public/shared/gates.js';
import { requireAdmin } from './auth.js';
import { pickPending, removeConnection, saveConnection, savePending } from './connections.js';
import { nonce, open, sameText, seal } from './crypto.js';
import { audit } from './data.js';
import { HttpError, cookie, scrub } from './http.js';
import { BRAND_ID } from './schema.js';
import { ADAPTERS, PlatformError, appConfigured } from './platforms.js';
import { backendFor, tenantStore } from './store.js';

// "Connect" = the standard OAuth authorization-code flow. The password is typed on the platform's
// own page; we only ever receive a token that is allowed to publish.

const FLOW_SECONDS = 600;
const cookieName = config => (config.secure ? '__Host-lumi-oauth' : 'lumi-dev-oauth');
const flowCookie = (config, value, seconds) => `${cookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`;
export const redirectUri = (config, platform) => `${config.origin}/api/callback/${platform}`;

export async function startConnect({ store, identity, config, brand, platform }) {
  requireAdmin(identity);
  if (!NATIVE_PLATFORMS.includes(platform)) throw new HttpError(400, '这个平台还不支持连接，先保持手动发布。');
  if (!appConfigured(config, platform)) throw new HttpError(409, '这个平台的开发者应用还没有配置。', 'APP_UNCONFIGURED');
  if (!(await store.readDocs('brands'))[brand]) throw new HttpError(404, '产品线不存在。');
  const n = nonce();
  // The state names the tenant and brand, is sealed so it cannot be altered, and is tied to this
  // browser through a short-lived cookie so nobody can finish someone else's connection.
  const state = seal(config.secret, 'oauth-state', { t: identity.tenantId, u: identity.userId, b: brand, p: platform, n, e: Date.now() + FLOW_SECONDS * 1000 });
  return { url: ADAPTERS[platform].authUrl({ config, redirectUri: redirectUri(config, platform), state }), setCookie: flowCookie(config, n, FLOW_SECONDS) };
}

// Returns where to send the browser next. Outcome codes are fixed strings, never platform text.
export async function finishConnect({ request, params, config, platform, env, fetcher = fetch }) {
  const back = outcome => ({ location: `${config.origin}/?connect=${outcome}&platform=${platform}#accounts`, setCookie: flowCookie(config, '', 0) });
  if (!config.origin || config.secret.length < 32) throw new HttpError(503, '服务还没有配置好。');
  const flow = open(config.secret, 'oauth-state', params.get('state') || '');
  const bound = cookie(request, cookieName(config));
  if (!flow || flow.p !== platform || flow.e < Date.now() || !bound || !sameText(bound, flow.n)) return back('expired');
  if (params.get('error') || !params.get('code')) return back('denied');
  const store = tenantStore(backendFor(env), flow.t);
  const identity = { userId: flow.u, tenantId: flow.t, role: 'admin' };
  try {
    const now = Date.now();
    const result = await ADAPTERS[platform].exchange({ config, code: params.get('code'), redirectUri: redirectUri(config, platform), fetcher, now });
    if (result.candidates) {
      await savePending(store, config.secret, { brand: flow.b, platform, candidates: result.candidates, userId: flow.u, now });
      return back('pick');
    }
    await saveConnection(store, config.secret, { brand: flow.b, platform, account: result.account, tokens: result.tokens, userId: flow.u, now });
    await audit(store, identity, 'connect', `${flow.b}_${platform}`, result.account.name);
    return back('ok');
  } catch (error) {
    console.error('[lumi-publish] connect failed:', platform, scrub(error?.message));
    return back(error instanceof PlatformError && ['NO_PAGE', 'NO_CHANNEL', 'NO_REFRESH'].includes(error.code) ? error.code.toLowerCase() : 'failed');
  }
}

const slot = (brand, platform) => { if (!BRAND_ID.test(brand) || !NATIVE_PLATFORMS.includes(platform)) throw new HttpError(400, '账号位无效。'); };

export async function selectChoice({ store, identity, config, brand, platform, id }) {
  requireAdmin(identity); slot(brand, platform);
  await pickPending(store, config.secret, { brand, platform, id: String(id || ''), userId: identity.userId, now: Date.now() });
  await audit(store, identity, 'connect', `${brand}_${platform}`, String(id));
  return { ok: true };
}

export async function disconnect({ store, identity, brand, platform }) {
  requireAdmin(identity); slot(brand, platform);
  await removeConnection(store, brand, platform);
  await audit(store, identity, 'disconnect', `${brand}_${platform}`);
  return { ok: true };
}
