import { open, seal } from './crypto.js';
import { HttpError } from './http.js';

// Platform tokens live in their own private document per tenant, and each token is additionally
// sealed with a key derived for that tenant. Tokens never leave the server.

const purpose = store => `tokens:${store.tenantId}`;
export const connKey = (brand, platform) => `${brand}_${platform}`;

export async function readConnections(store) { return (await store.read()).conns; }
const mutate = (store, fn) => store.update(state => ({ result: fn(state.conns) }));

// What the browser may see: who is connected, never the token.
export function publicView(conns) {
  return Object.fromEntries(Object.entries(conns).map(([key, c]) => [key, {
    brand: c.brand, platform: c.platform, status: c.status, name: c.name || '', externalId: c.externalId || '',
    connectedAt: c.connectedAt || 0, expiresAt: c.expiresAt || 0,
    ...(c.status === 'pick' ? { choices: (c.choices || []).map(x => ({ id: x.id, name: x.name })) } : {}),
  }]));
}

export function saveConnection(store, secret, { brand, platform, account, tokens, userId, now }) {
  return mutate(store, conns => {
    conns[connKey(brand, platform)] = { brand, platform, status: 'connected', externalId: account.id, name: account.name,
      sealed: seal(secret, purpose(store), tokens), expiresAt: tokens.expiresAt || 0, connectedAt: now, connectedBy: userId };
  });
}

// Facebook can return several Pages; hold them sealed until an admin picks one.
export function savePending(store, secret, { brand, platform, candidates, userId, now }) {
  return mutate(store, conns => {
    conns[connKey(brand, platform)] = { brand, platform, status: 'pick', choices: candidates.map(c => ({ id: c.account.id, name: c.account.name })),
      sealed: seal(secret, purpose(store), { candidates }), connectedAt: now, connectedBy: userId };
  });
}

export function pickPending(store, secret, { brand, platform, id, userId, now }) {
  return mutate(store, conns => {
    const conn = conns[connKey(brand, platform)];
    const chosen = conn?.status === 'pick' ? open(secret, purpose(store), conn.sealed)?.candidates?.find(c => c.account.id === id) : null;
    if (!chosen) throw new HttpError(404, '没有找到这个主页，请重新连接。');
    conns[connKey(brand, platform)] = { brand, platform, status: 'connected', externalId: chosen.account.id, name: chosen.account.name,
      sealed: seal(secret, purpose(store), chosen.tokens), expiresAt: chosen.tokens.expiresAt || 0, connectedAt: now, connectedBy: userId };
  });
}

export function removeConnection(store, brand, platform) {
  return mutate(store, conns => { delete conns[connKey(brand, platform)]; });
}

export async function loadTokens(store, secret, brand, platform) {
  const conn = (await readConnections(store))[connKey(brand, platform)];
  if (!conn || conn.status !== 'connected') return null;
  const tokens = open(secret, purpose(store), conn.sealed);
  return tokens ? { conn, tokens } : null;
}

export function updateTokens(store, secret, brand, platform, tokens) {
  return mutate(store, conns => {
    const conn = conns[connKey(brand, platform)];
    if (conn?.status === 'connected') { conn.sealed = seal(secret, purpose(store), tokens); conn.expiresAt = tokens.expiresAt || 0; }
  });
}
