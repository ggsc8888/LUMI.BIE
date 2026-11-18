import { createVerifier } from '../server/auth.js';
import { deleteDoc, getAll, importDesk, putDoc } from '../server/data.js';
import { settings } from '../server/env.js';
import { HttpError, handler, query, readJson, send } from '../server/http.js';
import { attachMedia, previewLink, removeMedia, uploadTicket } from '../server/media.js';
import { disconnect, selectChoice, startConnect } from '../server/oauth.js';
import { publishPost } from '../server/publish.js';
import { backendFor, tenantStore } from '../server/store.js';

const verify = createVerifier();

// One function, one `do` parameter per action (the same shape as World Builder's /api/auth?action=).
export default handler(async (request, response) => {
  const params = query(request), action = params.get('do') || '', config = settings();
  if (action === 'config') {
    // Public: only what the sign-in screen needs. Names of missing settings help with setup; values never leave.
    return send(response, 200, { configured: config.configured, missing: config.missing, dev: config.dev,
      publishableKey: config.dev ? '' : config.publishableKey, issuer: config.dev ? '' : config.issuer });
  }
  if (!config.configured) throw new HttpError(503, '服务还没有配置好。', 'UNCONFIGURED');
  const identity = await verify(request);
  const store = tenantStore(backendFor(), identity.tenantId);
  if (request.method === 'GET') {
    if (action === 'data') return send(response, 200, await getAll(store, identity, config));
    if (action === 'media-link') return send(response, 200, await previewLink({ store, config, postId: params.get('id') || '' }));
    throw new HttpError(404, '没有这个操作。');
  }
  if (request.method !== 'POST') throw new HttpError(405, '不支持的请求方式。');
  const body = await readJson(request);
  switch (action) {
    case 'doc-put': return send(response, 200, { doc: await putDoc(store, identity, String(body.coll), String(body.id), body.patch) });
    case 'doc-delete': return send(response, 200, await deleteDoc(store, identity, String(body.coll), String(body.id)));
    case 'import': return send(response, 200, await importDesk(store, identity, body));
    case 'publish': return send(response, 200, await publishPost({ store, identity, config, postId: String(body.id),
      options: { visibility: body.visibility, force: body.force === true } }));
    case 'connect-start': {
      const { url, setCookie } = await startConnect({ store, identity, config, brand: String(body.brand), platform: String(body.platform) });
      return send(response, 200, { url }, { 'Set-Cookie': setCookie });
    }
    case 'connect-select': return send(response, 200, await selectChoice({ store, identity, config, brand: String(body.brand), platform: String(body.platform), id: body.id }));
    case 'connect-disconnect': return send(response, 200, await disconnect({ store, identity, brand: String(body.brand), platform: String(body.platform) }));
    case 'media-ticket': return send(response, 200, await uploadTicket({ store, postId: String(body.postId), name: body.name, type: String(body.type), size: body.size }));
    case 'media-attach': return send(response, 200, { doc: await attachMedia({ store, identity, postId: String(body.postId), pathname: body.pathname, name: body.name }) });
    case 'media-remove': return send(response, 200, { doc: await removeMedia({ store, postId: String(body.postId) }) });
    default: throw new HttpError(404, '没有这个操作。');
  }
});
