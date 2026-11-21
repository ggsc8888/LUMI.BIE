export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function send(response, status, value, headers = {}) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  for (const [name, v] of Object.entries(headers)) response.setHeader(name, v);
  response.end(JSON.stringify(value));
}

export function redirect(response, location, headers = {}) {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  for (const [name, v] of Object.entries(headers)) response.setHeader(name, v);
  response.end();
}

export const query = request => new URL(request.url || '/', 'https://local.invalid').searchParams;

// Vercel may hand us a parsed body; the local dev server hands us the raw stream.
export async function readJson(request, limit = 300_000) {
  let body = request.body;
  if (body === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, '内容太大了。');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (body.length > limit) throw new HttpError(413, '内容太大了。');
    try { body = body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, '请求格式不对。'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求格式不对。');
  return body;
}

export function cookie(request, name) {
  const found = String(request.headers?.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return found.length === 1 ? found[0].slice(name.length + 1) : ''; // ambiguous duplicates are never accepted
}

// Never let an access token reach a log line or an error shown to the user.
export const scrub = text => String(text ?? '').replace(/(access_token|client_secret|refresh_token|code|fb_exchange_token)=[^&\s"']+/gi, '$1=…').slice(0, 400);

export function handler(fn) {
  return async (request, response) => {
    try { await fn(request, response); }
    catch (error) {
      if (error instanceof HttpError) return send(response, error.status, { error: error.message, code: error.code });
      console.error('[lumi-publish]', scrub(error?.message));
      send(response, 500, { error: '服务器出了点问题，稍后再试。' });
    }
  };
}
