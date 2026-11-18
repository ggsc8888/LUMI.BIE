import { BlobNotFoundError, BlobPreconditionFailedError, del, get, head, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { settings } from './env.js';
import { HttpError } from './http.js';

// Storage is private Vercel Blob (the same kind of store World Builder already uses). Each tenant
// gets one JSON file, written with an ETag precondition so two people saving at once never
// silently overwrite each other.

export function blobBackend(token) {
  const auth = { access: 'private', token };
  return {
    kind: 'blob',
    async read(path) {
      const result = await get(path, { ...auth, useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return { value: await new Response(result.stream).json(), etag: result.blob.etag };
    },
    async write(path, value, etag) {
      await put(path, JSON.stringify(value), { ...auth, contentType: 'application/json', addRandomSuffix: false,
        cacheControlMaxAge: 60, ...(etag ? { ifMatch: etag } : {}) });
    },
    isConflict: error => error instanceof BlobPreconditionFailedError || /already exists/i.test(error?.message || ''),
    async stat(path) {
      try { const info = await head(path, { token }); return { size: info.size, type: info.contentType || '' }; }
      catch (error) { if (error instanceof BlobNotFoundError) return null; throw error; }
    },
    async stream(path) {
      const result = await get(path, { ...auth });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return { stream: result.stream, size: result.blob.size, type: result.blob.contentType || 'application/octet-stream' };
    },
    async remove(path) { await del(path, { token }); },
    uploadToken: (pathname, { maxBytes, types }) => generateClientTokenFromReadWriteToken({ token, pathname,
      maximumSizeInBytes: maxBytes, allowedContentTypes: types, validUntil: Date.now() + 30 * 60_000, addRandomSuffix: false }),
  };
}

// Used by tests and the local dev server only.
export function memoryBackend() {
  const json = new Map(), files = new Map();
  let counter = 0;
  class Conflict extends Error {}
  return {
    kind: 'memory', files,
    async read(path) { const hit = json.get(path); return hit ? { value: JSON.parse(hit.text), etag: hit.etag } : null; },
    async write(path, value, etag) {
      const hit = json.get(path);
      if (etag ? !hit || hit.etag !== etag : !!hit) throw new Conflict('precondition failed');
      json.set(path, { text: JSON.stringify(value), etag: `m${++counter}` });
    },
    isConflict: error => error instanceof Conflict,
    async stat(path) { const f = files.get(path); return f ? { size: f.bytes.length, type: f.type } : null; },
    async stream(path) {
      const f = files.get(path); if (!f) return null;
      return { stream: new Blob([f.bytes]).stream(), size: f.bytes.length, type: f.type };
    },
    async remove(path) { files.delete(path); },
    uploadToken: null,
    putFile(path, bytes, type) { files.set(path, { bytes, type }); },
  };
}

let devBackend;
export function backendFor(env = process.env) {
  const config = settings(env);
  if (config.blobToken) return blobBackend(config.blobToken);
  if (config.dev) return devBackend ||= memoryBackend();
  throw new HttpError(503, '存储还没有配置好。', 'STORAGE_UNCONFIGURED');
}

export const COLLECTIONS = ['brands', 'posts', 'signals', 'assets', 'accounts'];
const KEYS = [...COLLECTIONS, 'audit'];
const TENANT = /^(org|user)_[A-Za-z0-9]+$/;

// Documents are looked up by ids that come from the browser. A map without a prototype has no
// "constructor" or "toString" entries to be mistaken for a stored document.
const bare = docs => Object.assign(Object.create(null), docs);
const shape = value => ({ v: 1, docs: Object.fromEntries(KEYS.map(k => [k, bare(value?.docs?.[k])])), conns: bare(value?.conns) });

// The only way to reach data: a store bound to one verified tenant id. Everything a tenant has
// (documents, sealed platform tokens, the audit trail) lives in one JSON file, so loading the page
// is one read and a save is one read plus one write. Blob bills per operation and Hobby's free
// allowance is small, so the number of calls matters more than the size of the file.
export function tenantStore(backend, tenantId) {
  if (!TENANT.test(tenantId)) throw new HttpError(400, '租户无效。');
  const base = `lumi-publish/v1/${tenantId}`, path = `${base}/state.json`;
  const read = async () => shape((await backend.read(path))?.value);
  // fn(state) changes a private copy in place and returns { result } to save it, or null / { skip: true, result } to leave storage alone.
  async function update(fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await backend.read(path);
      const state = shape(structuredClone(current?.value));
      const out = await fn(state);
      if (!out || out.skip) return out?.result;
      try { await backend.write(path, state, current?.etag || null); return out.result; }
      catch (error) { if (!backend.isConflict(error)) throw error; }
    }
    throw new HttpError(409, '别人刚好也在改，这次没保存上，再试一次。', 'CONFLICT');
  }
  return {
    tenantId, base, backend, read, update,
    async readDocs(name) { return (await read()).docs[name]; },
    async readAll(names = COLLECTIONS) { const state = await read(); return Object.fromEntries(names.map(n => [n, state.docs[n]])); },
    // Collection-shaped view of update(): fn(docs, state) returns { docs, result } to save, or null.
    mutate: (name, fn) => update(async state => {
      const out = await fn(state.docs[name], state);
      if (!out?.docs) return out ? { skip: true, result: out.result } : null;
      state.docs[name] = bare(out.docs);
      return { result: out.result };
    }),
  };
}
