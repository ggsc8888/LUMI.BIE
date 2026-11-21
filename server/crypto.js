import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// One master secret (LUMI_PUBLISH_SECRET); every use gets its own key through HKDF, so a value
// sealed for one purpose (or one tenant) cannot be opened as another.
const keyFor = (secret, purpose) => Buffer.from(hkdfSync('sha256', secret, 'lumi-publish/v1', purpose, 32));

export function seal(secret, purpose, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function open(secret, purpose, sealed) {
  try {
    const raw = Buffer.from(String(sealed), 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { return null; }
}

export const sign = (secret, purpose, text) => createHmac('sha256', keyFor(secret, purpose)).update(text).digest('base64url');

export function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export const nonce = (bytes = 18) => randomBytes(bytes).toString('base64url');
