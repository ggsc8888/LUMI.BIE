// Runtime settings. Everything secret stays server-side; nothing here is sent to the browser
// except what api/app.js explicitly puts in the public config.

function exactOrigin(value) {
  try { const url = new URL(value); return url.origin === value && !url.username && !url.password ? url : null; } catch { return null; }
}

// The Clerk Frontend API host is encoded in the publishable key.
export function clerkIssuer(publishableKey) {
  try {
    if (!/^pk_(test|live)_[A-Za-z0-9_-]+$/.test(publishableKey)) return '';
    const decoded = Buffer.from(publishableKey.split('_')[2], 'base64').toString();
    if (!decoded.endsWith('$')) return '';
    const host = decoded.slice(0, -1);
    return /^[a-z0-9.-]+$/.test(host) && host.includes('.') ? `https://${host}` : '';
  } catch { return ''; }
}

export function settings(env = process.env) {
  // Dev sign-in can never be switched on in a Vercel deployment or a production build.
  const dev = env.LUMI_DEV_AUTH === '1' && env.VERCEL !== '1' && env.NODE_ENV !== 'production';
  const publishableKey = env.CLERK_PUBLISHABLE_KEY || '';
  const issuer = clerkIssuer(publishableKey);
  const originText = (env.LUMI_PUBLISH_ORIGIN || '').trim();
  const originUrl = exactOrigin(originText);
  const originOk = !!originUrl && (originUrl.protocol === 'https:' ||
    (dev && originUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(originUrl.hostname)));
  const secret = env.LUMI_PUBLISH_SECRET || '';
  const missing = [];
  if (!dev && !issuer) missing.push('CLERK_PUBLISHABLE_KEY');
  if (!originOk) missing.push('LUMI_PUBLISH_ORIGIN');
  if (secret.length < 32) missing.push('LUMI_PUBLISH_SECRET');
  const blobToken = env.BLOB_READ_WRITE_TOKEN || '';
  if (!dev && !blobToken) missing.push('BLOB_READ_WRITE_TOKEN');
  const app = (id, appSecret) => ({ id: (id || '').trim(), secret: appSecret || '' });
  // Optional allow-list of Clerk user/organization ids. Unset = everyone who can sign in. Set but unreadable = nobody (fail closed).
  const allowText = (env.LUMI_PUBLISH_ALLOW || '').trim();
  const allow = allowText ? allowText.split(/[\s,]+/).filter(id => /^(user|org)_[A-Za-z0-9]+$/.test(id)) : null;
  return {
    dev, publishableKey, issuer, secret, blobToken, allow, missing, configured: missing.length === 0,
    origin: originOk ? originText : '', secure: originUrl?.protocol === 'https:',
    graph: /^v\d{1,3}\.\d$/.test(env.META_GRAPH_VERSION || '') ? env.META_GRAPH_VERSION : 'v27.0',
    apps: {
      instagram: app(env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET),
      facebook: app(env.META_APP_ID, env.META_APP_SECRET),
      youtube: app(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    },
  };
}
