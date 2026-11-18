// Shared by the browser and the server, so the page and the API can never disagree about
// whether a post may be approved or published.

export const PLATFORMS = ['instagram', 'xiaohongshu', 'tiktok', 'youtube', 'facebook'];
export const NATIVE_PLATFORMS = ['instagram', 'facebook', 'youtube'];
export const FORMATS = {
  video: { media: true }, note: { media: true }, carousel: { media: true },
  image: { media: true }, long: { media: true }, text: { media: false },
};
export const CONSENTS = ['pending', 'approved', 'denied', 'public'];
// Looked up with hasOwn so a name like "constructor" can never pass as a format.
export const isFormat = name => typeof name === 'string' && Object.hasOwn(FORMATS, name);
export const formatOf = name => (isFormat(name) ? FORMATS[name] : FORMATS.video);

export const usable = asset => !!asset && (asset.consent === 'approved' || asset.consent === 'public');

// ASCII terms match whole words only ("GIN" must not fire on "begin"); other scripts match anywhere.
export function termRe(term) {
  const t = String(term || '').trim();
  if (!t) return null;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[\x20-\x7e]+$/.test(t) ? new RegExp('(^|[^a-z0-9])' + escaped + '(?![a-z0-9])', 'i') : new RegExp(escaped, 'i');
}

export function leakHits(copy, terms) {
  const text = [copy.hook, copy.title, copy.body, (copy.tags || []).join(' ')].join('\n');
  return (terms || []).filter(t => { const re = termRe(t); return re && re.test(text); });
}

// post: the stored post. ctx: { terms, asset(id), signal(id) }. copy: live text while editing.
export function evalGates(post, ctx, copy = post) {
  const assets = (post.assets || []).map(id => ctx.asset(id)).filter(a => a && a.name);
  const waiting = assets.filter(a => !usable(a));
  const hits = leakHits(copy, ctx.terms);
  const needsMedia = formatOf(post.format).media;
  const trends = (post.signals || []).map(id => ctx.signal(id)).filter(s => s && s.kind === 'trend').length;
  return [
    { key: 'assets', ok: waiting.length === 0, count: assets.length, waiting: waiting.map(a => a.name) },
    { key: 'leak', ok: hits.length === 0 && !!post.ckLeak, hits },
    { key: 'media', ok: !needsMedia || !!post.ckMedia, na: !needsMedia },
    { key: 'facts', ok: trends === 0 || !!post.ckFacts, na: trends === 0, count: trends },
  ];
}

export const gatesPass = gates => gates.every(g => g.ok || g.na);
