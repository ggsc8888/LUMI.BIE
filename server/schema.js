import { CONSENTS, PLATFORMS, evalGates, gatesPass, isFormat, leakHits } from '../public/shared/gates.js';
import { HttpError } from './http.js';

// Every write goes through here. A patch only ever touches the fields listed below, so the
// browser cannot set server-owned fields (who approved, what was published, attached media).

export const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,79}$/;
export const BRAND_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const COLORS = ['plum', 'copper', 'teal', 'indigo', 'moss', 'slate'];
export const LIMITS = { brands: 40, posts: 6000, signals: 6000, assets: 3000, accounts: 400 };
const ACCOUNT_STATUS = ['none', 'registered', 'ready'];
const SIGNAL_KINDS = ['repo', 'trend'];

const has = (o, k) => Object.hasOwn(o, k);
const text = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
const isDate = v => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && !Number.isNaN(Date.parse(v));
const link = v => { const s = text(v, 500).trim(); return /^https?:\/\//i.test(s) ? s : ''; };
const list = (v, count, max) => [...new Set((Array.isArray(v) ? v : []).filter(x => typeof x === 'string').map(x => x.trim().slice(0, max)).filter(Boolean))].slice(0, count);
const bad = message => { throw new HttpError(400, message); };
const forbid = () => { throw new HttpError(403, '这一步需要管理员来做。', 'ADMIN_ONLY'); };

export const gateContext = (brand, all) => ({ terms: brand?.terms || [], asset: id => all.assets?.[id], signal: id => all.signals?.[id] });

function patchBrand(old, patch, { identity, now }) {
  if (identity.role !== 'admin') forbid();
  const next = { short: '', scope: '', audience: '', color: 'slate', strict: false, terms: [], facts: [], repos: [], dow: 5, order: now, ...old };
  if (has(patch, 'name') || !old) { next.name = text(patch.name, 60).trim(); if (!next.name) bad('产品线要有名字。'); }
  if (has(patch, 'short')) next.short = text(patch.short, 24).trim();
  if (!next.short) next.short = next.name.slice(0, 24);
  if (has(patch, 'scope')) next.scope = text(patch.scope, 120).trim();
  if (has(patch, 'audience')) next.audience = text(patch.audience, 60).trim();
  if (has(patch, 'color')) next.color = COLORS.includes(patch.color) ? patch.color : bad('颜色无效。');
  if (has(patch, 'strict')) next.strict = !!patch.strict;
  if (has(patch, 'dow')) next.dow = Number.isInteger(patch.dow) && patch.dow >= 1 && patch.dow <= 7 ? patch.dow : bad('发布日无效。');
  if (has(patch, 'order') && Number.isFinite(patch.order)) next.order = patch.order;
  if (has(patch, 'repos')) next.repos = list(patch.repos, 12, 80);
  if (has(patch, 'terms')) {
    const seen = new Set();
    next.terms = list(patch.terms, 100, 60).filter(t => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  }
  if (has(patch, 'facts')) {
    const seen = new Set();
    next.facts = (Array.isArray(patch.facts) ? patch.facts : []).map(f => ({ t: text(f?.t, 120).trim(), ok: !!f?.ok }))
      .filter(f => f.t && !seen.has(f.t) && seen.add(f.t)).slice(0, 50);
  }
  return next;
}

function patchPost(old, patch, { identity, now, all }) {
  const admin = identity.role === 'admin';
  const cur = old || { status: 'draft', hook: '', title: '', body: '', tags: [], media: '', assets: [], signals: [], out: '', url: '', ckLeak: false, ckMedia: false, ckFacts: false };
  const next = { ...cur };
  if (!old) {
    next.week = isDate(patch.week) ? patch.week : bad('周无效。');
    next.line = all.brands?.[patch.line] ? patch.line : bad('产品线不存在。');
    next.platform = PLATFORMS.includes(patch.platform) ? patch.platform : bad('平台无效。');
    next.format = 'video';
  }
  const locked = cur.status === 'published';
  const change = (key, value, same = (a, b) => a === b) => {
    if (same(value, cur[key] ?? (Array.isArray(value) ? [] : ''))) return false;
    if (locked) throw new HttpError(409, '已发布的内容不能再改。', 'LOCKED');
    next[key] = value; return true;
  };
  const sameList = (a, b) => a.join('\n') === (b || []).join('\n');
  let copyChanged = false;
  for (const [key, max] of [['hook', 300], ['title', 200], ['body', 6000]]) if (has(patch, key)) copyChanged = change(key, text(patch[key], max)) || copyChanged;
  if (has(patch, 'tags')) copyChanged = change('tags', list(patch.tags, 30, 60), sameList) || copyChanged;
  if (has(patch, 'media')) change('media', text(patch.media, 3000));
  if (has(patch, 'out')) change('out', text(patch.out, 300).trim());
  if (has(patch, 'format')) change('format', isFormat(patch.format) ? patch.format : bad('形式无效。'));
  if (has(patch, 'day')) change('day', isDate(patch.day) ? patch.day : '');
  if (has(patch, 'assets')) change('assets', list(patch.assets, 40, 80).filter(id => all.assets?.[id]?.line === next.line), sameList);
  if (has(patch, 'signals') && change('signals', list(patch.signals, 60, 80).filter(id => all.signals?.[id]?.line === next.line), sameList)) next.ckFacts = false;
  if (has(patch, 'url')) { const url = link(patch.url); if (url !== (cur.url || '')) { if (!admin) forbid(); next.url = url; } }
  // Changing the words voids the "nothing unpublished in here" confirmation and any approval.
  if (copyChanged) { next.ckLeak = false; if (next.status === 'approved') next.status = 'draft'; }
  for (const key of ['ckLeak', 'ckMedia', 'ckFacts']) {
    if (has(patch, key) && !!patch[key] !== !!next[key]) { if (!admin) forbid(); if (locked) throw new HttpError(409, '已发布的内容不能再改。', 'LOCKED'); next[key] = !!patch[key]; }
  }
  const ctx = gateContext(all.brands?.[next.line], all);
  if (next.ckLeak && leakHits(next, ctx.terms).length) next.ckLeak = false;
  if (has(patch, 'status') && patch.status !== next.status) {
    if (!admin) forbid();
    const from = next.status, to = patch.status;
    const passed = () => gatesPass(evalGates(next, ctx)) || (() => { throw new HttpError(409, '四道确认还没有全部通过。', 'GATES'); })();
    if (from === 'draft' && to === 'approved') { passed(); next.status = 'approved'; next.approvedAt = now; next.approvedBy = identity.userId; }
    else if (from === 'approved' && to === 'draft') next.status = 'draft';
    else if (from === 'approved' && to === 'published') { passed(); Object.assign(next, { status: 'published', publishedAt: now, publishedBy: identity.userId, publishedVia: 'manual' }); }
    else if (from === 'published' && to === 'approved') {
      if (cur.publishedVia === 'native') throw new HttpError(409, '这条是通过接口发出去的，不能在这里改回。', 'LOCKED');
      next.status = 'approved';
    } else bad('状态无效。');
  }
  next.updatedAt = now; next.updatedBy = identity.userId;
  return next;
}

function patchAsset(old, patch, { identity, now, all }) {
  const admin = identity.role === 'admin';
  const next = { kind: '其他', where: '', url: '', desc: '', consent: 'pending', ...old };
  if (!old) next.line = all.brands?.[patch.line] ? patch.line : bad('产品线不存在。');
  if (has(patch, 'name') || !old) { next.name = text(patch.name, 80).trim(); if (!next.name) bad('素材要有名字。'); }
  if (has(patch, 'kind')) next.kind = text(patch.kind, 12).trim() || '其他';
  if (has(patch, 'desc')) next.desc = text(patch.desc, 300).trim();
  if (has(patch, 'where')) { next.where = text(patch.where, 300).trim(); next.url = link(next.where); }
  if (has(patch, 'url') && link(patch.url)) next.url = link(patch.url);
  // Consent was given for the material as it was described. If what the entry points at changes, the decision starts over.
  if (old && old.consent !== 'pending' && ['name', 'where', 'url'].some(key => next[key] !== old[key])) {
    next.consent = 'pending'; delete next.decidedAt; delete next.decidedBy;
  }
  // Only an admin decides whether unpublished material may be used.
  if (has(patch, 'consent') && patch.consent !== next.consent) {
    if (!admin) forbid();
    next.consent = CONSENTS.includes(patch.consent) ? patch.consent : bad('同意状态无效。');
    next.decidedAt = now; next.decidedBy = identity.userId;
  }
  if (!old) { next.addedAt = now; next.addedBy = identity.userId; }
  return next;
}

function patchSignal(old, patch, { now, all }) {
  const next = { kind: 'repo', detail: '', source: '', url: '', date: '', angle: '', verify: true, ...old };
  if (!old) {
    next.week = isDate(patch.week) ? patch.week : bad('周无效。');
    next.line = all.brands?.[patch.line] ? patch.line : bad('产品线不存在。');
    next.addedAt = now;
  }
  // Whether something is an outside trend decides if its facts must be checked, so it is fixed when the entry is created.
  if (has(patch, 'kind') && !old) next.kind = SIGNAL_KINDS.includes(patch.kind) ? patch.kind : bad('类型无效。');
  if (has(patch, 'title') || !old) { next.title = text(patch.title, 120).trim(); if (!next.title) bad('要有一句话标题。'); }
  if (has(patch, 'detail')) next.detail = text(patch.detail, 400).trim();
  if (has(patch, 'source')) next.source = text(patch.source, 80).trim();
  if (has(patch, 'url')) next.url = link(patch.url);
  if (has(patch, 'date')) next.date = isDate(patch.date) ? patch.date : '';
  if (has(patch, 'angle')) next.angle = text(patch.angle, 300).trim();
  if (has(patch, 'verify')) next.verify = !!patch.verify;
  return next;
}

function patchAccount(old, patch, { all }, id) {
  const next = { handle: '', status: 'none', ...old };
  if (!old) {
    next.line = all.brands?.[patch.line] ? patch.line : bad('产品线不存在。');
    next.platform = PLATFORMS.includes(patch.platform) ? patch.platform : bad('平台无效。');
    if (id !== `${next.line}_${next.platform}`) bad('账号位无效。');
  }
  if (has(patch, 'handle')) next.handle = text(patch.handle, 60).trim().replace(/^@+/, '');
  if (has(patch, 'status')) next.status = ACCOUNT_STATUS.includes(patch.status) ? patch.status : bad('状态无效。');
  return next;
}

const PATCHERS = { brands: patchBrand, posts: patchPost, assets: patchAsset, signals: patchSignal, accounts: patchAccount };

export function applyPatch(coll, id, old, patch, ctx) {
  if (!PATCHERS[coll]) bad('没有这个集合。');
  if (!(coll === 'brands' ? BRAND_ID : DOC_ID).test(id)) bad('编号无效。');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('请求格式不对。');
  return PATCHERS[coll](old || null, patch, ctx, id);
}

export function checkDelete(coll, id, old, { identity, all }) {
  if (!PATCHERS[coll]) bad('没有这个集合。');
  const admin = identity.role === 'admin';
  if (coll === 'brands') {
    if (!admin) forbid();
    const used = ['posts', 'assets', 'signals'].some(c => Object.values(all[c] || {}).some(d => d.line === id));
    if (used) throw new HttpError(409, '这条产品线下面还有内容，先清空再删除。', 'IN_USE');
  } else if (coll === 'posts') {
    if (old.status !== 'draft' && !admin) forbid();
    if (old.publishedVia === 'native') throw new HttpError(409, '已经通过接口发出去的内容不能删除记录。', 'LOCKED');
  } else if (coll === 'assets' && !admin) forbid();
  else if (coll === 'signals' && !admin && Object.values(all.posts || {}).some(p => (p.signals || []).includes(id))) forbid(); // a post relies on it
}
