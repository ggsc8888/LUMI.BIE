// Test environment: dev sign-in (header-selected user/org/role) and the in-memory store.
process.env.LUMI_DEV_AUTH = '1';
process.env.LUMI_PUBLISH_ORIGIN = 'http://localhost:4173';
process.env.LUMI_PUBLISH_SECRET = 'test-secret-test-secret-test-secret-0123';
process.env.INSTAGRAM_APP_ID = 'ig-app'; process.env.INSTAGRAM_APP_SECRET = 'ig-secret';
process.env.META_APP_ID = 'fb-app'; process.env.META_APP_SECRET = 'fb-secret';
process.env.GOOGLE_CLIENT_ID = 'g-app'; process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
delete process.env.BLOB_READ_WRITE_TOKEN; delete process.env.VERCEL;

export const admin = (org = 'org_A', user = 'user_admin') => ({ userId: user, tenantId: org, tenantKind: 'org', role: 'admin' });
export const member = (org = 'org_A', user = 'user_member') => ({ userId: user, tenantId: org, tenantKind: 'org', role: 'member' });

// Calls a Vercel-style handler with a plain request and collects the response.
export async function call(handler, { method = 'GET', url, headers = {}, body, raw } = {}) {
  const out = { status: 0, headers: {}, text: '' };
  const request = raw ? Object.assign((async function* () { yield raw; })(), { method, url, headers }) : { method, url, headers, body };
  const response = {
    set statusCode(v) { out.status = v; }, get statusCode() { return out.status; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, getHeader: k => out.headers[k.toLowerCase()],
    end(v) { out.text = v || ''; out.done?.(); }, on() {}, once() {}, emit() {}, write(v) { out.text += v; return true; },
  };
  await handler(request, response);
  try { out.json = out.text ? JSON.parse(out.text) : null; } catch { out.json = null; }
  return out;
}

// A fetch stand-in that answers from a list of [matcher, reply] rules and records every call.
export function fakeFetch(rules) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    for (const [match, reply] of rules) {
      if (typeof match === 'string' ? String(url).includes(match) : match(String(url), init)) {
        const r = typeof reply === 'function' ? reply(String(url), init) : reply;
        if (r instanceof Error) throw r;
        return new Response(JSON.stringify(r.body ?? r), { status: r.status || 200, headers: r.headers || {} });
      }
    }
    throw new Error('unexpected request ' + url);
  };
  fetcher.calls = calls;
  return fetcher;
}

export const brand = { name: 'LUMI Agent', short: 'Agent', color: 'teal', terms: ['Orca', 'ACE', '蓝鲸'] };
export const draft = (line = 'agent') => ({ week: '2026-11-16', line, platform: 'instagram', format: 'image', hook: 'Hello.', title: 'Hi', body: 'Hello.\n\nWorld.', tags: ['#LUMI'] });
