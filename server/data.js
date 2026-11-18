import { NATIVE_PLATFORMS } from '../public/shared/gates.js';
import { publicView } from './connections.js';
import { HttpError } from './http.js';
import { appConfigured } from './platforms.js';
import { LIMITS, applyPatch, checkDelete } from './schema.js';
import { COLLECTIONS } from './store.js';

// The collection name becomes part of a storage path, so it is checked against the fixed list first.
const known = coll => { if (!COLLECTIONS.includes(coll)) throw new HttpError(400, '没有这个集合。'); };

const AUDIT_KEEP = 1000;
export async function audit(store, identity, action, target, detail = '') {
  try {
    await store.mutate('audit', docs => {
      const at = Date.now();
      docs[`${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`] = { at, by: identity.userId, action, target, detail: String(detail).slice(0, 200) };
      const keys = Object.keys(docs).sort();
      for (const key of keys.slice(0, Math.max(0, keys.length - AUDIT_KEEP))) delete docs[key];
      return { docs };
    });
  } catch { /* an audit hiccup must not undo the action it describes */ }
}

export async function getAll(store, identity, config) {
  const state = await store.read();
  return {
    ...Object.fromEntries(COLLECTIONS.map(name => [name, state.docs[name]])),
    connections: publicView(state.conns),
    me: { id: identity.userId, role: identity.role },
    tenant: { id: identity.tenantId, kind: identity.tenantKind },
    platforms: Object.fromEntries(NATIVE_PLATFORMS.map(p => [p, { configured: appConfigured(config, p) }])),
    uploads: store.backend.kind === 'blob' ? 'blob' : 'dev',
  };
}

export async function putDoc(store, identity, coll, id, patch) {
  known(coll);
  let before = null;
  const saved = await store.mutate(coll, (docs, state) => {
    const all = state.docs;
    before = docs[id] || null;
    if (!before && Object.keys(docs).length >= (LIMITS[coll] || 0)) throw new HttpError(409, '这一类内容已经到上限了，先清理一些旧的。', 'LIMIT');
    const next = applyPatch(coll, id, before, patch, { identity, now: Date.now(), all: { ...all, [coll]: docs } });
    docs[id] = next;
    return { docs, result: next };
  });
  if (coll === 'posts' && before?.status !== saved.status) await audit(store, identity, `post.${saved.status}`, id);
  if (coll === 'assets' && before?.consent !== saved.consent) await audit(store, identity, `asset.${saved.consent}`, id, saved.name);
  return saved;
}

export async function deleteDoc(store, identity, coll, id) {
  known(coll);
  let removed = null;
  await store.mutate(coll, (docs, state) => {
    const all = state.docs;
    if (!docs[id]) return null;
    checkDelete(coll, id, docs[id], { identity, all: { ...all, [coll]: docs } });
    removed = docs[id]; delete docs[id];
    return { docs };
  });
  if (removed && (coll === 'assets' || coll === 'signals')) {
    // Posts that pointed at the removed entry drop the reference.
    await store.mutate('posts', docs => {
      let touched = false;
      for (const post of Object.values(docs)) if ((post[coll] || []).includes(id)) { post[coll] = post[coll].filter(x => x !== id); touched = true; }
      return touched ? { docs } : null;
    });
  }
  if (removed?.mediaFile?.path) await store.backend.remove(removed.mediaFile.path).catch(() => {});
  if (removed) await audit(store, identity, `${coll}.delete`, id);
  return { ok: true };
}

// Bring in an export file: the original 发布台 page, or one week of signals and drafts. Every
// document goes through the same rules as a live edit, and approvals are replayed step by step,
// so nothing arrives "approved" unless it passes the gates here. One read and one write per
// collection, however many documents the file holds.
export async function importDesk(store, identity, payload) {
  if (identity.role !== 'admin') throw new HttpError(403, '这一步需要管理员来做。', 'ADMIN_ONLY');
  const counts = {}, now = Date.now();
  const attempt = fn => { try { fn(); return true; } catch (error) { if (error instanceof HttpError) return false; throw error; } };
  for (const coll of ['brands', 'assets', 'signals', 'accounts', 'posts']) {
    const incoming = payload?.[coll];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
    const entries = Object.entries(incoming).slice(0, 2000);
    await store.mutate(coll, (docs, state) => {
      const ctx = { identity, now, all: { ...state.docs, [coll]: docs } };
      const step = (id, patch) => { docs[id] = applyPatch(coll, id, docs[id] || null, patch, ctx); };
      let count = 0;
      for (const [id, doc] of entries) {
        if (!doc || typeof doc !== 'object' || (!docs[id] && Object.keys(docs).length >= (LIMITS[coll] || 0))) continue;
        if (coll !== 'posts') { if (attempt(() => step(id, doc))) count++; continue; }
        const { status, ckLeak, ckMedia, ckFacts, ...content } = doc;
        if (!attempt(() => step(id, content))) continue;
        count++;
        attempt(() => step(id, { ckLeak: !!ckLeak, ckMedia: !!ckMedia, ckFacts: !!ckFacts }));
        if (status === 'approved' || status === 'published') attempt(() => step(id, { status: 'approved' }));
        if (status === 'published') attempt(() => step(id, { status: 'published' }));
      }
      counts[coll] = count;
      return { docs, result: docs };
    });
  }
  await audit(store, identity, 'import', 'desk', JSON.stringify(counts));
  return { imported: counts };
}
