import { createRemoteJWKSet, jwtVerify } from 'jose';
import { settings } from './env.js';
import { HttpError } from './http.js';

const keySets = new Map();
const USER = /^user_[A-Za-z0-9]+$/, ORG = /^org_[A-Za-z0-9]+$/;

// A tenant is a Clerk organization; someone with no active organization works in a personal
// tenant that only they can reach. The tenant id always comes from the verified session, never
// from anything the browser sends in a body or query string.
function identityOf(userId, orgId, orgRole) {
  if (orgId) return { userId, tenantId: orgId, tenantKind: 'org', role: /(^|:)admin$/.test(orgRole || '') ? 'admin' : 'member' };
  return { userId, tenantId: userId, tenantKind: 'user', role: 'admin' };
}

// When LUMI_PUBLISH_ALLOW is set, only the listed people and organizations get in, even if the
// Clerk instance behind the sign-in is shared with another site.
function admit(config, identity) {
  if (config.allow && !config.allow.includes(identity.userId) && !config.allow.includes(identity.tenantId)) {
    throw new HttpError(403, '这个账号还没有开通发布台。', 'NOT_INVITED');
  }
  return identity;
}

export function createVerifier({ env = process.env, resolveKey, now } = {}) {
  return async request => {
    const config = settings(env);
    const headers = request.headers || {};
    if (config.dev) {
      const userId = USER.test(headers['x-dev-user'] || '') ? headers['x-dev-user'] : 'user_dev';
      const orgId = ORG.test(headers['x-dev-org'] || '') ? headers['x-dev-org'] : '';
      return admit(config, identityOf(userId, orgId, headers['x-dev-role'] === 'member' ? 'org:member' : 'org:admin'));
    }
    if (!config.issuer || !config.origin) throw new HttpError(503, '登录暂时不可用。', 'AUTH_UNCONFIGURED');
    if (headers.origin && headers.origin !== config.origin) throw new HttpError(403, '请从发布台网站操作。');
    if (headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请从发布台网站操作。');
    const token = headers['x-lumi-session'];
    if (typeof token !== 'string' || !token || token.length > 16_000) throw new HttpError(401, '请先登录。', 'SIGN_IN_REQUIRED');
    let keys = resolveKey;
    if (!keys) {
      if (!keySets.has(config.issuer)) keySets.set(config.issuer, createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`), { timeoutDuration: 5000 }));
      keys = keySets.get(config.issuer);
    }
    let identity;
    try {
      const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'], issuer: config.issuer,
        requiredClaims: ['iss', 'sub', 'sid', 'iat', 'exp', 'nbf', 'azp'], clockTolerance: 5, maxTokenAge: 120,
        ...(now ? { currentDate: now() } : {}) });
      if (payload.azp !== config.origin || !USER.test(payload.sub) || payload.sts === 'pending') throw Error();
      // Session token v2 nests the active organization under `o`; v1 used flat org_* claims.
      const org = payload.o && typeof payload.o === 'object' ? payload.o : null;
      const orgId = org?.id ?? payload.org_id ?? '';
      if (orgId && !ORG.test(orgId)) throw Error();
      identity = identityOf(payload.sub, orgId, org?.rol ?? payload.org_role);
    } catch { throw new HttpError(401, '登录已过期，请重新登录。', 'SIGN_IN_REQUIRED'); }
    return admit(config, identity);
  };
}

export function requireAdmin(identity) {
  if (identity.role !== 'admin') throw new HttpError(403, '这一步需要管理员来做。', 'ADMIN_ONLY');
}
