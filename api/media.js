import { createVerifier } from '../server/auth.js';
import { settings } from '../server/env.js';
import { HttpError, handler, query, send } from '../server/http.js';
import { MEDIA_TYPES, serveSigned } from '../server/media.js';
import { backendFor, tenantStore } from '../server/store.js';

const verify = createVerifier();

export default handler(async (request, response) => {
  const params = query(request), config = settings();
  if (!config.configured) throw new HttpError(503, '服务还没有配置好。', 'UNCONFIGURED');
  if (request.method === 'GET' || request.method === 'HEAD') return serveSigned({ request, response, params, config });
  // Local development only: there is no Blob store to upload to, so accept the bytes directly.
  if (request.method === 'POST' && config.dev) {
    const identity = await verify(request);
    const store = tenantStore(backendFor(), identity.tenantId);
    const pathname = params.get('pathname') || '', type = request.headers['content-type'] || '';
    if (store.backend.kind !== 'memory' || !pathname.startsWith(`${store.base}/media/`) || !MEDIA_TYPES.includes(type)) throw new HttpError(400, '文件位置无效。');
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 60 * 1024 * 1024) throw new HttpError(413, '文件太大了。'); chunks.push(chunk); }
    store.backend.putFile(pathname, Buffer.concat(chunks), type);
    return send(response, 200, { ok: true });
  }
  throw new HttpError(405, '不支持的请求方式。');
});
