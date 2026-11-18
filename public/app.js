import { evalGates, leakHits as termHits, usable } from './shared/gates.js';

const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl=u=>{u=String(u||'').trim();return /^https?:\/\//i.test(u)?u:''};
const str=(v,max)=>String(v??'').slice(0,max);

let LINES=[]; // 每个租户自己的产品线，从服务器来
const FORMATS={
  video:{name:'竖版短视频',spec:'9:16',media:true},
  note:{name:'图文笔记',spec:'3:4',media:true},
  carousel:{name:'多图轮播',spec:'4:5',media:true},
  image:{name:'单图配文',spec:'4:5',media:true},
  long:{name:'横版长视频',spec:'16:9',media:true},
  text:{name:'纯文字',spec:'',media:false},
};
const PLATFORMS=[
  {id:'instagram',native:true,name:'Instagram',fmt:'video',titleMax:0,bodyMax:2200,titleLabel:'画面大字',lang:'英文',pub:'https://www.instagram.com/'},
  {id:'xiaohongshu',name:'小红书',fmt:'note',titleMax:20,bodyMax:1000,titleLabel:'标题',lang:'简体中文',pub:'https://creator.xiaohongshu.com/publish/publish'},
  {id:'tiktok',name:'TikTok',fmt:'video',titleMax:0,bodyMax:2200,titleLabel:'画面大字',lang:'英文',pub:'https://www.tiktok.com/tiktokstudio/upload'},
  {id:'youtube',native:true,name:'YouTube',fmt:'video',titleMax:100,bodyMax:5000,titleLabel:'标题',lang:'英文',pub:'https://studio.youtube.com/'},
  {id:'facebook',native:true,name:'Facebook',fmt:'image',titleMax:0,bodyMax:0,titleLabel:'画面大字',lang:'英文',pub:'https://business.facebook.com/'},
];
const BRAND_DEFAULTS={strict:false,terms:[],facts:[],repos:[],dow:5};
const STATUS={draft:{name:'草稿',cls:'s-draft'},approved:{name:'已通过',cls:'s-ok'},published:{name:'已发布',cls:'s-pub'}};
const CONSENT={pending:'待你决定',approved:'同意使用',denied:'不同意',public:'已公开过'};
const ACC={none:'还没注册',registered:'已注册',ready:'已登录，可以发'};
const KINDS=['场景','插画','原型图','截图','视频','其他'];
const COLLS=['brands','posts','signals','assets','accounts'];
const COLOR_NAMES={plum:'梅紫',copper:'铜橙',teal:'青绿',indigo:'靛蓝',moss:'苔绿',slate:'石青'};

/* 日期 */
const pad=n=>String(n).padStart(2,'0');
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const isDate=s=>/^\d{4}-\d\d-\d\d$/.test(s||'');
const parse=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)};
const mondayOf=d=>{const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-(x.getDay()+6)%7);return x};
const addDays=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return iso(d)};
const isoWeek=s=>{const d=parse(s),t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const k=t.getUTCDay()||7;t.setUTCDate(t.getUTCDate()+4-k);const y0=new Date(Date.UTC(t.getUTCFullYear(),0,1));return{year:t.getUTCFullYear(),week:Math.ceil(((t-y0)/864e5+1)/7)}};
const DOW=['周日','周一','周二','周三','周四','周五','周六'];
const md=s=>{const d=parse(s);return `${d.getMonth()+1}月${d.getDate()}日`};
const dayLabel=s=>{if(!isDate(s))return '日期未定';const d=parse(s);return `${DOW[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`};
const thisWeek=()=>iso(mondayOf(new Date()));

/* 状态 */
const S={view:'week',week:thisWeek(),brands:new Map(),posts:new Map(),signals:new Map(),assets:new Map(),accounts:new Map(),
  connections:{},platforms:{},role:'member',space:null,loaded:false,stale:false,host:'pending',missing:[],denied:'',clerk:null,dev:false,
  assetFilter:'all',edit:null,uploading:null,publishing:null};
const lineOf=id=>LINES.find(l=>l.id===id)||{id,name:'已删除的产品线',short:'已删除',scope:'',audience:'受众',color:'slate'};
const pfOf=id=>PLATFORMS.find(p=>p.id===id)||PLATFORMS[0];
const fmtOf=(p,P)=>Object.hasOwn(FORMATS,p.format||'')?FORMATS[p.format]:FORMATS[P.fmt];
const st=line=>({...BRAND_DEFAULTS,...(S.brands.get(line)||{})});
const acc=(line,pf)=>S.accounts.get(line+'_'+pf)||{};
const postId=(week,line,pf)=>`${week}_${line}_${pf}`;
const list=(map,fn)=>[...map].map(([id,v])=>({id,...v})).filter(fn||(()=>true));
const weekPosts=()=>list(S.posts,p=>p.week===S.week);
const weekSignals=line=>list(S.signals,s=>s.week===S.week&&(!line||s.line===line));
const lineAssets=line=>list(S.assets,a=>!line||a.line===line);
const ready=()=>S.host==='ready'&&S.loaded;
const isAdmin=()=>S.role==='admin';
const conn=(line,pf)=>S.connections[line+'_'+pf]||null;
const connected=(line,pf)=>(conn(line,pf)||{}).status==='connected';
const acctName=(line,pf)=>connected(line,pf)?conn(line,pf).name:(acc(line,pf).handle||'');
const acctLabel=(line,pf)=>{const n=acctName(line,pf);return !n?'':connected(line,pf)&&pf!=='instagram'?n:'@'+n};
const acctReady=(line,pf)=>connected(line,pf)||acc(line,pf).status==='ready';
const splitTags=s=>String(s||'').split(/[\s,，、]+/).map(t=>t.trim()).filter(Boolean).slice(0,30);
const len=s=>[...String(s||'')].length;

/* 保密词与四道确认：判定规则和服务器共用 shared/gates.js 同一份代码 */
const leakHits=(copy,line)=>termHits(copy,st(line).terms);
function gatesFor(p,copy){
  const[a,l,m,f]=evalGates(p,{terms:st(p.line).terms,asset:id=>S.assets.get(id),signal:id=>S.signals.get(id)},copy||p);
  return [
    {...a,title:'用到的素材都已获同意',detail:a.count?(a.waiting.length?`还有 ${a.waiting.length} 个没同意：${a.waiting.join('、')}`:`${a.count} 个素材均可使用`):'这条没有关联素材库里的素材'},
    {...l,title:'文案里没有未公开的信息',ck:'ckLeak',ckLabel:'我看过了，没有不能说的内容',ckOff:l.hits.length>0,
      detail:l.hits.length?`命中保密词：${l.hits.join('、')}。改掉之后才能确认。`:'保密词扫描通过，还需要管理员亲自确认一次'},
    {...m,title:'成品图片或视频已经看过并同意',ck:m.na?null:'ckMedia',ckLabel:'成品我看过了，可以发',detail:m.na?'纯文字，不需要成品':'做好的图片或视频，要管理员点头才算数'},
    {...f,title:'借用的热点已经核对过原文',ck:f.na?null:'ckFacts',ckLabel:'热点里的事实我核对过了',detail:f.na?'这条没有借热点':`这条借了 ${f.count} 个热点，发之前对一下原文`},
  ];
}
const blockers=p=>gatesFor(p).filter(g=>!g.ok&&!g.na);

/* 存取：先在本页生效，再存到服务器；最后以服务器返回的为准 */
const devHeaders=()=>{const q=new URLSearchParams(location.search),h={};if(q.get('org'))h['X-Dev-Org']=q.get('org');
  if(q.get('as')==='member'){h['X-Dev-Role']='member';h['X-Dev-User']='user_member'}return h};
async function authHeaders(){
  if(S.dev)return devHeaders();
  const token=S.clerk&&S.clerk.session?await S.clerk.session.getToken():null;
  if(!token)throw{status:401,message:'登录已过期，刷新页面重新登录。'};
  return{'X-Lumi-Session':token};
}
async function api(action,body,extra=''){
  const headers=await authHeaders();if(body)headers['Content-Type']='application/json';
  let res;
  try{res=await fetch(`/api/app?do=${action}${extra}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,cache:'no-store'})}
  catch(e){throw{status:0,message:'网络不通，稍后再试。'}}
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw{status:res.status,code:data.code,message:data.error||'请求没有成功，稍后再试。'};
  return data;
}
const chains=new Map(),inflight=new Map();let writes=0,writeSeq=0;
function track(key,run){
  writes++;writeSeq++;inflight.set(key,(inflight.get(key)||0)+1);
  const done=()=>{writes--;inflight.set(key,inflight.get(key)-1);scheduleRender()};
  chains.set(key,(chains.get(key)||Promise.resolve()).then(run).then(done,done));
}
function saveDoc(coll,id,patch){
  const old=S[coll].get(id),key=coll+'/'+id;
  S[coll].set(id,{...(old||{}),...patch});if(coll==='brands')syncLines();
  // 同一条内容连着改了几次时，只采用最后一次的返回，避免中间结果把后面的输入盖掉。
  track(key,()=>api('doc-put',{coll,id,patch}).then(r=>{if(inflight.get(key)===1){S[coll].set(id,r.doc);if(coll==='brands')syncLines()}},e=>{toast(e.message);return refresh(true)}));
  scheduleRender();
}
function dropDoc(coll,id){
  S[coll].delete(id);if(coll==='brands')syncLines();
  track(coll+'/'+id,()=>api('doc-delete',{coll,id}).catch(e=>{toast(e.message);return refresh(true)}));
  scheduleRender();
}
function setAll(d){
  for(const k of COLLS)S[k]=new Map(Object.entries(d[k]||{}));
  S.connections=d.connections||{};S.platforms=d.platforms||{};S.role=(d.me||{}).role||'member';S.space={tenant:(d.tenant||{}).id||'',me:(d.me||{}).id||''};
  S.loaded=true;S.stale=false;syncLines();
}
// 页面上的数据和服务器返回的是否一样（用来判断要不要重绘）
const snap=o=>JSON.stringify([COLLS.map(k=>o[k]||{}),o.connections||{},o.platforms||{},o.role]);
const localSnap=()=>snap({...Object.fromEntries(COLLS.map(k=>[k,Object.fromEntries(S[k])])),connections:S.connections,platforms:S.platforms,role:S.role});
// own=true 只在某次保存失败后由它自己调用：那次保存还算在 writes 里。
async function refresh(own){
  if(!own)await Promise.allSettled([...chains.values()]); // 先等手上的改动存完
  const quiet=()=>writes<=(own?1:0),seq=writeSeq;
  if(!quiet())return;
  try{
    const d=await api('data');
    if(!quiet()||seq!==writeSeq)return; // 拉取期间又改过东西，这次结果就不用了
    // 没有变化就不重绘，免得打断正在填的表单
    if(!own&&S.loaded&&!S.stale&&snap({...d,role:(d.me||{}).role||'member'})===localSnap())return;
    setAll(d);
  }catch(e){
    if(e.code==='NOT_INVITED'){S.host='denied';S.denied='invite'}
    else if(e.status===401&&!S.dev){
      // 第一次就被拒绝，多半是部署配置和网址对不上；这时不能刷新，否则会一直转圈。
      if(S.loaded){location.reload();return}
      S.host='denied';S.denied=e.message;
    }else if(!S.loaded){S.host='down'}
    else S.stale=true;
  }
  scheduleRender();
}
function syncLines(){LINES=list(S.brands).sort((a,b)=>(a.order||0)-(b.order||0)||a.id.localeCompare(b.id))
  .map(b=>({id:b.id,name:b.name||b.id,short:b.short||b.name||b.id,scope:b.scope||'',audience:b.audience||'受众',color:COLOR_NAMES[b.color]?b.color:'slate'}))}
const savePost=(id,patch)=>saveDoc('posts',id,patch);
const saveSettings=(line,patch)=>saveDoc('brands',line,patch);
const newId=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);

/* 提示 */
function toast(t){const p=document.createElement('p');p.textContent=t;$('#toast').append(p);setTimeout(()=>p.remove(),4200)}
function ask(msg,ok='确定'){return new Promise(res=>{const d=$('#ask');
  d.innerHTML=`<form method="dialog" class="askbox"><p>${esc(msg)}</p><div class="row end"><button class="btn" value="no">取消</button><button class="btn primary" value="yes">${esc(ok)}</button></div></form>`;
  d.returnValue='';d.onclose=()=>res(d.returnValue==='yes');d.showModal()})}
function showText(text){const d=$('#ask');
  d.innerHTML=`<form method="dialog" class="askbox"><p>没能自动复制。请在下面全选后手动复制。</p><textarea id="ask-text" readonly></textarea><div class="row end"><button class="btn primary" value="no">好</button></div></form>`;
  d.onclose=null;d.showModal();const t=$('#ask-text');t.value=text;t.focus();t.select()}
async function copy(text,what){try{await navigator.clipboard.writeText(text);toast(`已复制${what||''}`)}catch(e){showText(text)}}

/* 渲染调度：输入框有焦点或鼠标按下时不重绘，避免打断输入法和点击 */
let queued=false,pending=false,edPending=false,pointerDown=false;
const main=$('#main');
function scheduleRender(){if(queued)return;queued=true;queueMicrotask(()=>{queued=false;render();refreshEditor()})}
document.addEventListener('pointerdown',()=>{pointerDown=true},true);
const pointerEnd=()=>{pointerDown=false;if(pending)setTimeout(render,0);if(edPending)setTimeout(refreshEditor,0)};
document.addEventListener('pointerup',pointerEnd,true);
document.addEventListener('pointercancel',pointerEnd,true);
document.addEventListener('pointermove',e=>{if(pointerDown&&e.buttons===0)pointerEnd()},true);
main.addEventListener('focusout',()=>{if(pending)setTimeout(render,0)});
function render(force){
  document.body.dataset.host=S.host;
  if(S.host==='signin'&&$('#signin'))return;
  const ae=document.activeElement;
  const typing=ae&&main.contains(ae)&&/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)&&ae.type!=='checkbox';
  if(!force&&(typing||pointerDown)){pending=true;return}
  pending=false;
  const keep=force&&typing&&ae.id?ae.id:null;
  const w=isoWeek(S.week);
  $('#wk-num').textContent=`${w.year} 第 ${w.week} 周`;
  $('#wk-range').textContent=`${md(S.week)} – ${md(addDays(S.week,6))}`;
  $('#wk-today').hidden=S.week===thisWeek();
  $$('.tabs a').forEach(a=>a.dataset.tab===S.view?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current'));
  $('#notice').innerHTML=notices();
  main.innerHTML=S.host==='signin'?'<div class="signin" id="signin"></div>':S.host==='setup'?setupView():S.host==='denied'?deniedView():ready()?(LINES.length||S.view==='accounts'?VIEWS[S.view]():emptyView()):S.host==='down'?'':`<p class="muted">正在读取…</p>`;
  mountSignIn();
  if(keep){const el=document.getElementById(keep);if(el)el.focus()}
}
function notices(){
  const out=[];
  if(S.host==='down')out.push(['warn',S.denied==='signin'?'登录组件没有加载出来，刷新页面再试。':'连不上服务，刷新页面再试。']);
  if(S.dev&&S.host==='ready')out.push(['info','本地开发模式：数据只在内存里，重启就没了。']);
  if(S.host==='ready'&&S.loaded&&!isAdmin())out.push(['info','你是成员：可以写草稿、加素材和进展。同意素材、确认、审核和发布要管理员来做。']);
  if(S.stale)out.push(['warn','数据暂时连不上，下面显示的可能不是最新的。']);
  return out.map(([k,t])=>`<p class="note ${k}">${t}</p>`).join('');
}
const pill=s=>{const x=STATUS[s]||STATUS.draft;return `<span class="pill ${x.cls}">${x.name}</span>`};
const adm=()=>isAdmin()?'':'disabled';
const kept=new Set();
document.addEventListener('toggle',e=>{const k=e.target.dataset&&e.target.dataset.keep;if(k)e.target.open?kept.add(k):kept.delete(k)},true);
const keep=key=>`data-keep="${key}" ${kept.has(key)?'open':''}`;
const setHTML=(el,html)=>{if(el&&el.__h!==html){el.innerHTML=html;el.__h=html}};
const fmtSize=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';

/* 视图：本周排期 */
const emptyView=()=>`<section class="card"><h3>先建第一条产品线</h3><p>每条产品线有自己的一套账号、素材、保密规则和每周内容。${isAdmin()?'':'请管理员来添加。'}</p><div class="row"><a class="btn primary" href="#accounts">去添加产品线</a></div></section>`;
function viewWeek(){
  const posts=weekPosts(),sigs=weekSignals();
  const by=new Map(posts.map(p=>[p.line+'_'+p.platform,p]));
  const n=s=>posts.filter(p=>(p.status||'draft')===s).length;
  const waitAssets=lineAssets().filter(a=>!a.consent||a.consent==='pending').length;
  const notReady=LINES.reduce((n,L)=>n+PLATFORMS.filter(P=>!acctReady(L.id,P.id)).length,0);
  const todo=[];
  if(!posts.length)todo.push(`这一周还没有内容。点空格子新建一条。`);
  if(waitAssets)todo.push(`<a href="#assets">${waitAssets} 个素材</a>等你决定能不能用`);
  if(n('draft'))todo.push(`${n('draft')} 条草稿等你审：点开格子，过完四道确认再通过`);
  if(n('approved'))todo.push(`${n('approved')} 条已通过，等你发出去并回填链接`);
  if(notReady)todo.push(`<a href="#accounts">${notReady} 个账号</a>还没准备好`);
  const board=LINES.map(L=>{
    const s=st(L.id),mine=posts.filter(p=>p.line===L.id);
    const okN=mine.filter(p=>p.status==='approved'||p.status==='published').length;
    const cells=PLATFORMS.map(P=>{
      const p=by.get(L.id+'_'+P.id);
      if(!p)return `<button class="cell empty ln-${L.color}" data-act="new-post" data-line="${L.id}" data-pf="${P.id}"><span class="pfname">${P.name}</span>＋ 新建一条</button>`;
      const a=acc(L.id,P.id),b=blockers(p),hits=leakHits(p,p.line);
      const wait=(p.assets||[]).map(id=>S.assets.get(id)).filter(x=>x&&!usable(x)).length;
      const flags=[];
      if(hits.length)flags.push(`<span class="flag bad">保密词 ${hits.length}</span>`);
      if(wait)flags.push(`<span class="flag warn">素材待同意 ${wait}</span>`);
      if(p.status==='approved'&&b.length)flags.push(`<span class="flag bad">确认已失效</span>`);
      if((p.status||'draft')==='draft'&&!hits.length&&!wait)flags.push(b.length?`<span class="flag plain">还差 ${b.length} 道确认</span>`:`<span class="flag ok">可以通过了</span>`);
      return `<button class="cell ln-${L.color}" data-act="open" data-id="${esc(p.id)}">
        <span class="cell-top"><span class="pfname">${P.name}</span>${pill(p.status)}<span class="fmt">${fmtOf(p,P).name}</span></span>
        <span class="ttl">${esc(p.title||p.hook||'（还没写）')}</span>
        <span class="meta">${dayLabel(p.day)} · ${esc(acctLabel(L.id,P.id))||'账号未登记'}</span>
        <span class="flags">${flags.join('')}</span></button>`;
    }).join('');
    return `<div class="line ln-${L.color}"><div class="rowhead">
        <b>${esc(L.name)}</b><span class="scope">${esc(L.scope)}</span>
        <span class="rowstat">已通过 <span class="num">${okN} / ${PLATFORMS.length}</span> · 默认${DOW[(s.dow||5)%7]}发</span>
      </div>${cells}</div>`;
  }).join('');
  return `<section class="overview">
    <div class="card"><ul class="pipe">
      <li><b>${sigs.length}</b><span>条进展与热点</span></li>
      <li><b>${n('draft')}</b><span>条草稿</span></li>
      <li><b>${n('approved')}</b><span>条已通过</span></li>
      <li><b>${n('published')}</b><span>条已发布</span></li></ul>
      <p class="rhythm">一周怎么转：记下这一周的进展和热点、写草稿 → 管理员定素材、看成品、过四道确认 → ${LINES.map(L=>({d:st(L.id).dow||5,n:L.short})).sort((a,b)=>a.d-b.d).map(x=>`${DOW[x.d%7]} ${esc(x.n)}`).join('、')} 发布 → 发完的链接会记在这条内容上。</p></div>
    <div class="card"><h3>等你处理</h3><ul class="todo">${todo.map(t=>`<li>${t}</li>`).join('')||'<li class="done">这一周没有卡在你这里的事</li>'}</ul></div>
  </section>
  <section class="board" aria-label="本周发布矩阵">
    <div class="colheads"><div></div>${PLATFORMS.map(P=>`<div class="colhead"><b>${P.name}</b><span>${FORMATS[P.fmt].name}</span></div>`).join('')}</div>
    ${board}
  </section>`;
}

/* 视图：素材与保密 */
function viewAssets(){
  const f=S.assetFilter,all=lineAssets(),rows=all.filter(a=>f==='all'||a.line===f).sort((a,b)=>(a.line+a.name).localeCompare(b.line+b.name,'zh'));
  const used=id=>list(S.posts,p=>(p.assets||[]).includes(id)).length;
  const c=k=>all.filter(a=>(a.consent||'pending')===k).length;
  const filt=[['all','全部'],...LINES.map(L=>[L.id,L.short])].map(([v,t])=>`<button class="btn sm" data-act="filter" data-v="${v}" aria-pressed="${f===v}">${esc(t)}</button>`).join('');
  const items=rows.map(a=>{const L=lineOf(a.line),u=safeUrl(a.url),k=a.consent||'pending',n=used(a.id);
    return `<article class="asset ln-${L.color}"><div>
      <h3>${esc(a.name)} <span class="flag plain">${esc(a.kind||'其他')}</span> <span class="chip-line">${esc(L.short)}</span></h3>
      ${a.desc?`<p>${esc(a.desc)}</p>`:''}
      <p class="src">${u?`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(a.where||u)}</a>`:esc(a.where||'')}${n?` · 用在 ${n} 条内容里`:''}</p></div>
      <div class="side"><div class="seg" role="group" aria-label="${esc(a.name)}能不能用">
        ${Object.entries(CONSENT).map(([v,t])=>`<button data-act="consent" data-id="${esc(a.id)}" data-v="${v}" aria-pressed="${k===v}" ${adm()}>${t}</button>`).join('')}</div>
        <button class="btn quiet sm danger" data-act="del-asset" data-id="${esc(a.id)}" ${adm()}>移除</button></div></article>`}).join('');
  const rules=LINES.map(L=>{const s=st(L.id);
    return `<section class="card rule-card ln-${L.color}"><h3>${esc(L.name)}</h3>
      <label class="switch"><input type="checkbox" id="strict-${L.id}" data-strict="${L.id}" ${s.strict?'checked':''} ${adm()}><span><b>严格保密</b><br><span class="muted">打开后，制作说明里关于产品只允许体现下面打了勾的事，其余只做氛围。</span></span></label>
      <div class="field"><span class="lbl">可以对外说的事</span>
        <ul class="facts">${(s.facts||[]).map((x,i)=>`<li><label><input type="checkbox" id="fact-${L.id}-${i}" data-fact="${L.id}" data-t="${esc(x.t)}" ${x.ok?'checked':''} ${adm()}><span>${esc(x.t)}</span></label><button class="btn quiet sm" data-act="del-fact" data-line="${L.id}" data-t="${esc(x.t)}" aria-label="删除" ${adm()}>×</button></li>`).join('')||'<li class="muted">还没有。</li>'}</ul>
        <form class="inline-form" data-form="fact" data-line="${L.id}"><input type="text" id="fact-new-${L.id}" name="t" placeholder="加一条，默认不打勾" maxlength="120" aria-label="新增可以对外说的事" ${adm()}><button class="btn sm" ${adm()}>添加</button></form></div>
      <div class="field"><span class="lbl">保密词（文案里出现就拦下）</span>
        <div class="chips">${(s.terms||[]).map((t,i)=>`<span class="chip">${esc(t)}<button data-act="del-term" data-line="${L.id}" data-t="${esc(t)}" aria-label="删除 ${esc(t)}" ${adm()}>×</button></span>`).join('')||'<span class="muted">还没有。</span>'}</div>
        <form class="inline-form" data-form="term" data-line="${L.id}"><input type="text" id="term-new-${L.id}" name="t" placeholder="角色名、地名、代号…" maxlength="60" aria-label="新增保密词" ${adm()}><button class="btn sm" ${adm()}>添加</button></form></div>
    </section>`}).join('');
  return `<div class="sec-head"><h1>素材</h1><p>没公开过的图片、原型、录屏和视频，要管理员点了“同意使用”才能进内容。共 ${all.length} 个：${c('pending')} 个待你决定，${c('approved')+c('public')} 个可用，${c('denied')} 个不同意。</p></div>
    <div class="filter">${filt}</div>
    <div class="assets">${items||'<p class="muted">这里还没有素材。</p>'}</div>
    <details class="add" ${keep('add-asset')}><summary>添加素材</summary>
      <form data-form="asset">
        <div class="grid2">
          <div class="field"><label class="lbl" for="as-line">产品线</label><select id="as-line" name="line">${LINES.map(L=>`<option value="${L.id}" ${f===L.id?'selected':''}>${esc(L.name)}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="as-kind">类型</label><select id="as-kind" name="kind">${KINDS.map(k=>`<option>${k}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="as-name">名称</label><input type="text" id="as-name" name="name" required maxlength="80"></div>
        </div>
        <div class="field"><label class="lbl" for="as-where">在哪里（仓库路径、文件夹或链接）</label><input type="text" id="as-where" name="where" maxlength="300"></div>
        <div class="field"><label class="lbl" for="as-desc">说明</label><input type="text" id="as-desc" name="desc" maxlength="300"></div>
        <div class="row"><button class="btn primary">加入素材库</button><span class="muted">新加的素材默认是“待你决定”。</span></div>
      </form></details>
    <div class="sec-head"><h1>保密规则</h1><p>每条线各有一套。保密词会自动扫描每条文案，命中就不能通过审核；服务器在发布前还会再查一遍。</p></div>
    <div class="rules">${rules}</div>`;
}

/* 视图：账号 */
function connBlock(L,P){
  const c=conn(L.id,P.id),at=`data-line="${L.id}" data-pf="${P.id}"`;
  if(c&&c.status==='connected'){
    const expired=P.id==='instagram'&&c.expiresAt&&c.expiresAt<Date.now(); // Instagram 的授权 60 天不用会过期
    return `<div class="conn">${expired?'<span class="flag bad">授权已过期</span>':'<span class="flag ok">已连接</span>'}<b>${esc(acctLabel(L.id,P.id))}</b>
    ${expired?`<button class="btn sm primary" data-act="connect" ${at} ${adm()}>重新连接</button>`:''}<button class="btn quiet sm danger" data-act="disconnect" ${at} ${adm()}>断开</button></div>`;
  }
  if(c&&c.status==='pick')return `<div class="conn"><span class="lbl">选一个主页连到这条线</span>
    ${(c.choices||[]).map(x=>`<button class="btn sm" data-act="pick-page" ${at} data-id="${esc(x.id)}" ${adm()}>${esc(x.name)}</button>`).join('')}
    <button class="btn quiet sm" data-act="disconnect" ${at} ${adm()}>取消</button></div>`;
  return `<div class="conn">${(S.platforms[P.id]||{}).configured
    ?`<button class="btn sm primary" data-act="connect" ${at} ${adm()}>连接 ${P.name}</button>`
    :`<span class="muted">${P.name} 的开发者应用还没配置，先手动发布。</span>`}</div>`;
}
function viewAccounts(){
  const total=LINES.length*PLATFORMS.length,readyN=LINES.reduce((n,L)=>n+PLATFORMS.filter(P=>acctReady(L.id,P.id)).length,0);
  const rows=LINES.map(L=>`<div class="line ln-${L.color}"><div class="rowhead"><b>${esc(L.name)}</b><span class="scope">${esc(L.scope)}</span></div>
    ${PLATFORMS.map(P=>{const a=acc(L.id,P.id),k=`${L.id}-${P.id}`,inUse=!!a.handle||(a.status||'none')!=='none';
      const manual=`<div class="field"><label class="lbl" for="acc-s-${k}">状态</label><select id="acc-s-${k}" data-acc="${L.id}|${P.id}" data-k="status">${Object.entries(ACC).map(([v,t])=>`<option value="${v}" ${(a.status||'none')===v?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="acc-h-${k}">账号名</label><input type="text" id="acc-h-${k}" data-acc="${L.id}|${P.id}" data-k="handle" value="${esc(a.handle||'')}" placeholder="不带 @" maxlength="60" autocomplete="off"></div>`;
      return `<div class="acct-cell ln-${L.color} ${acctReady(L.id,P.id)?'ready':''}"><span class="pfname">${P.name}</span>
        ${P.native?connBlock(L,P):''}
        ${connected(L.id,P.id)?'':P.native&&!inUse?`<details class="manual" ${keep('acc-'+k)}><summary>不连接，先手动发</summary>${manual}</details>`:manual}
      </div>`}).join('')}</div>`).join('');
  const colorOpts=sel=>Object.entries(COLOR_NAMES).map(([v,t])=>`<option value="${v}" ${sel===v?'selected':''}>${t}</option>`).join('');
  const lines=LINES.map(L=>{const b=S.brands.get(L.id)||{};
    return `<li class="brand-row ln-${L.color}"><span class="swatch" aria-hidden="true"></span>
      <div class="field"><label class="lbl" for="br-n-${L.id}">名称</label><input type="text" id="br-n-${L.id}" data-brand="${L.id}" data-k="name" value="${esc(b.name||'')}" maxlength="60" ${adm()}></div>
      <div class="field"><label class="lbl" for="br-s-${L.id}">做什么</label><input type="text" id="br-s-${L.id}" data-brand="${L.id}" data-k="scope" value="${esc(b.scope||'')}" maxlength="120" ${adm()}></div>
      <div class="field"><label class="lbl" for="br-c-${L.id}">颜色</label><select id="br-c-${L.id}" data-brand="${L.id}" data-k="color" ${adm()}>${colorOpts(L.color)}</select></div>
      <div class="field"><label class="lbl" for="br-d-${L.id}">默认发布日</label><select id="br-d-${L.id}" data-brand="${L.id}" data-k="dow" ${adm()}>${[1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${(b.dow||5)===n?'selected':''}>${DOW[n%7]}</option>`).join('')}</select></div>
      <button class="btn quiet sm danger" data-act="del-brand" data-id="${L.id}" ${adm()}>删除</button></li>`}).join('');
  return `<div class="sec-head"><h1>产品线</h1><p>每条产品线有自己的一套账号、素材、保密规则和每周内容。</p></div>
    <section class="card"><ul class="brands">${lines||'<li class="muted">还没有产品线。</li>'}</ul>
      <form class="brand-add" data-form="brand"><div class="field"><label class="lbl" for="br-new-n">新产品线的名称</label><input type="text" id="br-new-n" name="name" required maxlength="60" ${adm()}></div>
        <div class="field"><label class="lbl" for="br-new-s">做什么</label><input type="text" id="br-new-s" name="scope" maxlength="120" ${adm()}></div>
        <div class="field"><label class="lbl" for="br-new-c">颜色</label><select id="br-new-c" name="color" ${adm()}>${colorOpts(Object.keys(COLOR_NAMES)[LINES.length%6])}</select></div>
        <button class="btn primary" ${adm()}>添加产品线</button></form>
      <details class="add" ${keep('import')}><summary>从文件导入</summary><div class="row"><input type="file" id="import-file" accept="application/json,.json" ${adm()}><span class="muted">选一份导出的 JSON：旧发布台的数据，或者一周的进展和草稿。导入的内容按同样的规则重新校验，不会带着“已通过”混进来。</span></div></details>
    </section>
    <div class="sec-head"><h1>账号</h1><p>每条线在每个平台各用一个独立账号，互不混用。已就绪 <span class="num">${readyN} / ${total}</span>。</p></div>
    ${LINES.length?`<section class="acct board" aria-label="账号矩阵">
      <div class="colheads"><div></div>${PLATFORMS.map(P=>`<div class="colhead"><b>${P.name}</b><a href="${P.pub}" target="_blank" rel="noopener">发布入口 ↗</a></div>`).join('')}</div>
      ${rows}</section>`:''}
    ${isAdmin()&&S.space?`<p class="muted num" style="font-size:12px">当前空间 ${esc(S.space.tenant)} · 你 ${esc(S.space.me)}</p>`:''}
    <p class="muted" style="max-width:72ch">“连接”会跳到平台自己的页面，你在那里登录要连的账号并点允许。这里拿到的只是一枚能发内容的令牌，看不到密码，随时可以断开。小红书和 TikTok 目前只登记账号，发布时由你在平台里手动发。</p>`;
}

/* 视图：进展与热点 */
function viewSources(){
  const used=id=>list(S.posts,p=>(p.signals||[]).includes(id)).length;
  const item=s=>{const u=safeUrl(s.url),n=used(s.id),trend=s.kind==='trend';
    return `<article class="sig"><h4>${esc(s.title)}</h4>${s.detail?`<p>${esc(s.detail)}</p>`:''}
      <div class="srcrow">${s.date?`<span>${esc(s.date)}</span>`:''}${u?`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(s.source||'来源')} ↗</a>`:(s.source?`<span>${esc(s.source)}</span>`:'')}
        ${trend?(s.verify===false?'':'<span class="flag warn">发布前核对原文</span>'):'<span class="flag plain">内部资料</span>'}${n?`<span>用在 ${n} 条内容里</span>`:''}
        <button class="btn quiet sm danger" data-act="del-signal" data-id="${esc(s.id)}">删除</button></div>
      ${trend?`<div class="field angle"><label class="lbl" for="ang-${esc(s.id)}">怎么借这个热点</label><input type="text" id="ang-${esc(s.id)}" data-angle="${esc(s.id)}" value="${esc(s.angle||'')}" maxlength="300"></div>`:''}</article>`};
  const blocks=LINES.map(L=>{const s=st(L.id),sig=weekSignals(L.id),prog=sig.filter(x=>x.kind!=='trend'),tr=sig.filter(x=>x.kind==='trend');
    return `<section class="srcline ln-${L.color}"><header><h2>${esc(L.name)}</h2>
        <div class="field" style="flex:1;min-width:240px"><label class="lbl" for="repos-${L.id}">看哪些仓库（逗号分隔）</label><input type="text" id="repos-${L.id}" data-repos="${L.id}" value="${esc((s.repos||[]).join(', '))}" ${adm()}></div></header>
      <div class="srccols">
        <div class="card"><h3>本周进展 <span class="muted num">${prog.length}</span></h3><div class="sigs">${prog.map(item).join('')||'<p class="muted">这一周还没有记录。</p>'}</div></div>
        <div class="card"><h3>热点与可以借的角度 <span class="muted num">${tr.length}</span></h3><div class="sigs">${tr.map(item).join('')||'<p class="muted">这一周还没有记录。</p>'}</div></div>
      </div>
      <details class="add" ${keep('add-signal-'+L.id)}><summary>补充一条</summary>
        <form data-form="signal" data-line="${L.id}">
          <div class="grid2">
            <div class="field"><label class="lbl" for="sg-kind-${L.id}">类型</label><select id="sg-kind-${L.id}" name="kind"><option value="repo">本周进展（内部）</option><option value="trend">热点（外部）</option></select></div>
            <div class="field"><label class="lbl" for="sg-title-${L.id}">一句话</label><input type="text" id="sg-title-${L.id}" name="title" required maxlength="120"></div>
          </div>
          <div class="field"><label class="lbl" for="sg-detail-${L.id}">说明</label><input type="text" id="sg-detail-${L.id}" name="detail" maxlength="400"></div>
          <div class="grid2">
            <div class="field"><label class="lbl" for="sg-source-${L.id}">来源</label><input type="text" id="sg-source-${L.id}" name="source" maxlength="80"></div>
            <div class="field"><label class="lbl" for="sg-url-${L.id}">链接</label><input type="url" id="sg-url-${L.id}" name="url" placeholder="https://"></div>
          </div>
          <div class="row"><button class="btn primary">加到这一周</button></div>
        </form></details></section>`}).join('');
  return `<div class="sec-head"><h1>进展与热点</h1><p>每周的内容从这里来：仓库里的新进展，加上这一周外面在聊什么。内部进展只用来写草稿，不要原样出现在文案里。</p></div>${blocks}`;
}
const VIEWS={week:viewWeek,assets:viewAssets,accounts:viewAccounts,sources:viewSources};

/* 抽屉：一条内容 */
const ed=$('#ed');
function openEditor(id){
  const p=S.posts.get(id);if(!p)return;
  S.edit=id;
  const L=lineOf(p.line),P=pfOf(p.platform),v=f=>esc(p[f]||''),hasTitle=!!P.titleMax;
  ed.innerHTML=`
  <div class="ed-head ln-${L.color}">
    <div class="ed-id"><span class="chip-line">${esc(L.short)}</span><h2 id="ed-title">${P.name}</h2><span id="ed-status"></span></div>
    <button class="btn quiet sm" data-act="close-ed">关闭</button>
    <p class="ed-acct" id="ed-acct"></p>
  </div>
  <div class="ed-body">
    <section class="card"><h3>文案</h3>
      <div class="field"><label class="lbl" for="ed-hook"><span>开头钩子（视频前两秒 / 第一行）</span><span class="cnt" data-cnt="hook"></span></label><textarea id="ed-hook" data-f="hook" rows="2" maxlength="300">${v('hook')}</textarea></div>
      <div class="field"><label class="lbl" for="ed-ttl"><span>${P.titleLabel}</span><span class="cnt" data-cnt="title"></span></label><input type="text" id="ed-ttl" data-f="title" value="${v('title')}" maxlength="200"></div>
      <div class="field"><label class="lbl" for="ed-body-t"><span>${hasTitle?'正文':'配文'}</span><span class="cnt" data-cnt="body"></span></label><textarea id="ed-body-t" data-f="body" rows="10" maxlength="6000">${v('body')}</textarea></div>
      <div class="field"><label class="lbl" for="ed-tags"><span>话题标签（空格分开）</span><span class="cnt" data-cnt="tags"></span></label><input type="text" id="ed-tags" data-f="tags" value="${esc((p.tags||[]).join(' '))}" maxlength="600"></div>
      <div id="ed-leak"></div>
    </section>
    <section class="card"><h3>画面与成品</h3>
      <div class="grid2">
        <div class="field"><label class="lbl" for="ed-format">形式</label><select id="ed-format" data-f="format">${Object.entries(FORMATS).map(([k,F])=>`<option value="${k}" ${(p.format||P.fmt)===k?'selected':''}>${F.name}${F.spec?' '+F.spec:''}</option>`).join('')}</select></div>
        <div class="field"><label class="lbl" for="ed-day">发布日</label><input type="date" id="ed-day" data-f="day" value="${isDate(p.day)?p.day:''}"></div>
      </div>
      <div class="field"><label class="lbl" for="ed-media">画面与分镜</label><textarea id="ed-media" data-f="media" rows="5" maxlength="3000">${v('media')}</textarea></div>
      <div class="field"><span class="lbl">用到素材库里的哪些素材</span><div class="picks" id="ed-assets"></div></div>
      <div class="field"><span class="lbl">成品文件</span><div id="ed-upload"></div></div>
      <div class="field"><label class="lbl" for="ed-out">成品放在哪（文件夹或链接，可不填）</label><input type="text" id="ed-out" data-f="out" value="${v('out')}" maxlength="300"></div>
      <div class="row" id="ed-brief"></div>
    </section>
    <section class="card"><h3>这条依据的进展与热点</h3><div class="picks" id="ed-signals"></div></section>
    <section class="card"><h3>发布前确认</h3><ul class="gates" id="ed-gates"></ul></section>
    <section class="card"><h3>发布</h3>
      <div id="ed-pub"></div>
      <div class="field"><label class="lbl" for="ed-url">发出去之后的链接</label><input type="url" id="ed-url" data-f="url" value="${v('url')}" placeholder="https://" maxlength="500"></div>
    </section>
  </div>
  <div class="ed-foot" id="ed-actions"></div>`;
  refreshEditor();
  if(!ed.open)ed.showModal();
}
function edCopy(){const g=f=>{const el=$(`#ed [data-f="${f}"]`);return el?el.value:''};return{hook:g('hook'),title:g('title'),body:g('body'),tags:splitTags(g('tags'))}}
function refreshEditor(src){
  const id=S.edit;if(!id||!ed.firstChild)return;
  if(pointerDown){edPending=true;return}
  edPending=false;
  const p=S.posts.get(id);if(!p){if(ed.open)ed.close();return}
  const L=lineOf(p.line),P=pfOf(p.platform),a=acc(p.line,p.platform),status=p.status||'draft';
  const locked=status==='published',copyNow=edCopy(),g=gatesFor(p,copyNow),allOk=g.every(x=>x.ok||x.na);
  $('#ed-status').innerHTML=pill(status);
  const who=acctLabel(p.line,p.platform);
  $('#ed-acct').innerHTML=`${dayLabel(p.day)} · ${who?`用 <b>${esc(who)}</b> 发布${connected(p.line,p.platform)?'（已连接，可以直接发）':''}`:`这个账号还没准备好，<a href="#accounts" data-act="close-ed">去账号页</a>`}${status==='published'?' · 已发布的内容不能再改':''}`;
  // 没在输入的字段，跟上别处的改动
  $$('#ed [data-f]').forEach(el=>{const f=el.dataset.f;
    if(el!==document.activeElement&&el!==src){const want=f==='tags'?(p.tags||[]).join(' '):f==='format'?(p.format||P.fmt):f==='day'?(isDate(p.day)?p.day:''):(p[f]||'');
      if(f==='tags'?splitTags(el.value).join(' ')!==want:el.value!==want)el.value=want}
    el.disabled=f==='url'?(status==='draft'||!isAdmin()):locked});
  const c2=edCopy();
  const cnt=(k,n,max)=>{const el=$(`#ed [data-cnt="${k}"]`);if(!el)return;el.textContent=max?`${n} / ${max}`:`${n}`;el.classList.toggle('over',!!max&&n>max)};
  cnt('hook',len(c2.hook),0);cnt('title',len(c2.title),P.titleMax);cnt('body',len(c2.body),P.bodyMax);cnt('tags',c2.tags.length,0);
  const hits=leakHits(c2,p.line);
  $('#ed-leak').innerHTML=hits.length?`<p class="note warn">命中保密词：${hits.map(esc).join('、')}。这些词不能出现在对外文案里。</p>`:'';
  // 素材
  const assets=lineAssets(p.line).sort((x,y)=>x.name.localeCompare(y.name,'zh'));
  $('#ed-assets').innerHTML=assets.map(x=>{const k=x.consent||'pending';
    return `<label class="pick"><input type="checkbox" id="pa-${esc(x.id)}" data-pick="assets" value="${esc(x.id)}" ${(p.assets||[]).includes(x.id)?'checked':''} ${locked?'disabled':''}>
      <span><b>${esc(x.name)}</b> <span class="flag ${usable(x)?'ok':k==='denied'?'bad':'warn'}">${CONSENT[k]}</span><small>${esc(x.desc||x.where||'')}</small></span></label>`}).join('')
    ||`<p class="muted">这条线的素材库还是空的，可以到“素材与保密”里添加。</p>`;
  const waiting=(p.assets||[]).map(i=>S.assets.get(i)).filter(x=>x&&!usable(x)).length;
  $('#ed-brief').innerHTML=`<button class="btn sm" data-act="copy-brief" ${waiting?'disabled':''}>复制制作说明</button><span class="muted">${waiting?`有 ${waiting} 个素材还没同意，暂时不能开始制作。`:'把这份说明交给做图、做视频的人或工具，成品做好后传到下面。'}</span>`;
  // 依据
  const sig=weekSignals(p.line);
  $('#ed-signals').innerHTML=sig.map(s=>`<label class="pick"><input type="checkbox" id="ps-${esc(s.id)}" data-pick="signals" value="${esc(s.id)}" ${(p.signals||[]).includes(s.id)?'checked':''} ${locked?'disabled':''}>
      <span><b>${esc(s.title)}</b> <span class="flag ${s.kind==='trend'?'warn':'plain'}">${s.kind==='trend'?'热点':'内部进展'}</span><small>${esc(s.detail||'')}</small></span></label>`).join('')
    ||`<p class="muted">这一周还没有这条线的进展或热点。</p>`;
  // 四道确认
  $('#ed-gates').innerHTML=g.map(x=>`<li class="${x.na?'na':x.ok?'ok':'todo-g'}"><span class="mark" aria-hidden="true"></span><div><b>${x.title}</b><small>${esc(x.detail)}</small>
      ${x.ck?`<label><input type="checkbox" id="ck-${x.ck}" data-ck="${x.ck}" ${p[x.ck]?'checked':''} ${locked||x.ckOff||!isAdmin()?'disabled':''}><span>${x.ckLabel}</span></label>`:''}</div></li>`).join('');
  // 成品
  const mf=p.mediaFile,up=S.uploading&&S.uploading.id===id?S.uploading:null;
  setHTML($('#ed-upload'),up?`<span class="muted">正在上传… ${up.pct||0}%</span>`
    :mf?`<div class="row"><span class="flag plain">${String(mf.type).startsWith('video/')?'视频':'图片'}</span><b>${esc(mf.name||'成品')}</b><span class="muted">${fmtSize(mf.size||0)}</span>
        <button class="btn sm" data-act="media-preview">预览</button>${locked?'':`<button class="btn quiet sm danger" data-act="media-remove">移除</button>`}</div>`
    :locked?`<span class="muted">没有上传成品。</span>`
    :`<div class="row"><input type="file" id="ed-file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"><span class="muted">上传做好的图片或视频，上限 500 MB。换文件后要重新确认。</span></div>`);
  // 发布
  const native=!!P.native&&connected(p.line,p.platform),busy=S.publishing===id;
  const note=status!=='approved'?'':p.publishUncertain?`<p class="note warn">上次发布没有收到 ${P.name} 的确认，可能已经发出去了。先到平台上核对；确认没有发出去，再点“重试发布”。</p>`
    :p.pending?`<p class="note info">${P.name} 还在处理这个文件。过一两分钟点“继续发布”。</p>`
    :p.publishError?`<p class="note warn">上次没发成功：${esc(p.publishError.message)}</p>`:'';
  setHTML($('#ed-pub'),status==='draft'?`<p class="muted">通过审核之后，这里会出现发布用的按钮。</p>`
    :`${note}<div class="row"><button class="btn sm" data-act="copy-all">复制整条文案</button><button class="btn sm" data-act="copy-part" data-k="hook">只复制钩子</button><button class="btn sm" data-act="copy-part" data-k="tags">只复制标签</button>
       <a class="btn sm" href="${P.pub}" target="_blank" rel="noopener">打开 ${P.name} 发布页 ↗</a>${safeUrl(p.url)?`<a class="btn sm" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">看已发布的内容 ↗</a>`:''}</div>
     ${status==='approved'&&native&&P.id==='youtube'?`<div class="field" style="max-width:240px"><label class="lbl" for="ed-vis">YouTube 可见范围</label><select id="ed-vis"><option value="public">公开</option><option value="unlisted">不公开列出</option><option value="private">仅自己可见</option></select></div>`:''}`);
  const miss=g.filter(x=>!x.ok&&!x.na).map(x=>x.title);
  setHTML($('#ed-actions'),!isAdmin()?`<span class="why">${status==='draft'?'写好后请管理员来确认和审核。':status==='approved'?'已通过，等管理员发布。':'已发布。'}</span>`
    :status==='draft'
    ?`<button class="btn primary" data-act="approve" ${allOk?'':'disabled'}>通过审核</button><span class="why">${allOk?'四道确认都过了。':'还差：'+miss.join('；')}</span><button class="btn quiet danger" data-act="del-post">删除这条</button>`
    :status==='approved'
    ?(native
      ?`<button class="btn primary" data-act="native-publish" ${p.publishUncertain?'data-force="1"':''} ${allOk&&!busy?'':'disabled'}>${busy?'正在发布…':p.publishUncertain?'重试发布':p.pending?'继续发布':'发布到 '+P.name}</button><span class="why">${allOk?`会用 ${esc(who)} 直接发出去，发了就收不回。`:'确认已失效：'+miss.join('；')}</span><button class="btn quiet" data-act="publish" ${allOk&&!busy?'':'disabled'}>我已经手动发了</button><button class="btn quiet" data-act="to-draft" ${busy?'disabled':''}>退回草稿</button>`
      :`<button class="btn primary" data-act="publish" ${allOk?'':'disabled'}>我已经发出去了</button><span class="why">${allOk?'发完把链接填在上面，再点这里。':'确认已失效：'+miss.join('；')}</span><button class="btn quiet" data-act="to-draft">退回草稿</button>`)
    :`<span class="why">已发布${p.publishedAt?' · '+new Date(p.publishedAt).toLocaleDateString('zh-CN'):''}${p.publishedVia==='native'?' · 通过接口发出':''}</span>${p.publishedVia==='native'?'':`<button class="btn quiet" data-act="unpublish">改回“已通过”</button>`}`);
}
ed.addEventListener('click',e=>{if(e.target===ed)ed.close()});
ed.addEventListener('close',()=>{S.edit=null;ed.innerHTML='';render()});

function fullCopy(p){const P=pfOf(p.platform),t=(p.tags||[]).join(' ');return [(P.titleMax&&p.title)?p.title:'',p.body||'',t].filter(Boolean).join('\n\n')}
function briefFor(p){
  const L=lineOf(p.line),P=pfOf(p.platform),F=fmtOf(p,P),s=st(p.line);
  const assets=(p.assets||[]).map(i=>S.assets.get(i)).filter(usable);
  const facts=(s.facts||[]).filter(f=>f.ok).map(f=>f.t);
  return [`【内容制作任务】`,`产品线：${L.name}（${L.scope}）`,`平台与形式：${P.name} · ${F.name}${F.spec?'（'+F.spec+'）':''}`,`发布日：${isDate(p.day)?p.day:'未定'}`,``,
    `开头钩子：${p.hook||''}`,`${P.titleLabel}：${p.title||''}`,``,`文案：`,p.body||'',``,`画面与分镜：`,p.media||'',``,
    `可以使用的素材（都已获同意，只能用这些）：`,...(assets.length?assets.map(a=>`- ${a.name}${a.where?'（'+a.where+'）':''}`):['- 无。不要使用任何未公开的图片、原型或录屏。']),``,
    `保密要求：`,`- 画面和屏幕文字里不能出现：${(s.terms||[]).join('、')||'（无）'}`,
    s.strict?`- 关于产品只能体现这些已同意公开的信息：${facts.join('；')||'（无）'}；其余只做氛围。`:`- 不展示账号、密钥、真实客户信息。`,
    `- 不使用他人作品或他人产品的画面。`,``,`交付：成品先放到约定的文件夹给我看，我确认之前不要发布到任何平台。`].join('\n');
}

/* 成品上传、原生发布、导入 */
async function uploadMedia(file){
  const id=S.edit;if(!id||S.uploading)return;
  S.uploading={id,pct:0};refreshEditor();
  try{
    const t=await api('media-ticket',{postId:id,name:file.name,type:file.type,size:file.size});
    if(t.mode==='blob'){
      const{put}=await import('./vendor/blob-client.js');
      await put(t.pathname,file,{access:'private',token:t.token,contentType:file.type,multipart:file.size>8e6,
        onUploadProgress:e=>{if(S.uploading){S.uploading.pct=Math.round(e.percentage||0);refreshEditor()}}});
    }else{
      const r=await fetch('/api/media?pathname='+encodeURIComponent(t.pathname),{method:'POST',headers:{...await authHeaders(),'Content-Type':file.type},body:file});
      if(!r.ok)throw{message:'上传没有成功，再试一次。'};
    }
    const r=await api('media-attach',{postId:id,pathname:t.pathname,name:file.name});
    S.posts.set(id,r.doc);toast('成品已上传。管理员看过之后再确认。');
  }catch(err){toast(err.message||'上传没有成功，再试一次。')}
  finally{S.uploading=null;scheduleRender()}
}
async function nativePublish(id,force){
  const p=S.posts.get(id);if(!p||S.publishing)return;
  const P=pfOf(p.platform),vis=($('#ed-vis')||{}).value;
  if(!await ask(`用 ${acctLabel(p.line,p.platform)} 把这条发到 ${P.name}？发出去之后，这里撤不回来。`,force?'我核对过了，重试':'发布'))return;
  S.publishing=id;refreshEditor();
  try{const r=await api('publish',{id,visibility:vis,force});S.posts.set(id,r.post);toast(r.pending?`${P.name} 还在处理，稍后点“继续发布”。`:`已发布到 ${P.name}。`)}
  catch(err){toast(err.message);await refresh()}
  finally{S.publishing=null;scheduleRender()}
}
function showMedia(url,type){const d=$('#ask');
  d.innerHTML=`<form method="dialog" class="askbox">${String(type).startsWith('video/')?`<video class="preview" src="${esc(url)}" controls playsinline></video>`:`<img class="preview" src="${esc(url)}" alt="成品预览">`}<div class="row end"><button class="btn primary" value="no">关闭</button></div></form>`;
  d.onclose=()=>{d.innerHTML=''};d.showModal()}
async function importFile(file){
  try{
    const data=JSON.parse(await file.text());
    if(!await ask('把这个文件里的产品线、素材、进展和草稿导入到当前空间？已有的同名内容会被更新。','导入'))return;
    const r=await api('import',data);await refresh();
    toast('导入完成：'+Object.entries(r.imported||{}).map(([k,n])=>`${k} ${n}`).join('，'));
  }catch(err){toast(err.message||'这个文件读不了，确认是导出的 JSON。')}
}

/* 事件 */
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b||b.disabled)return;
  const a=b.dataset.act,d=b.dataset,id=S.edit,p=id&&S.posts.get(id);
  if(a==='reload'){location.reload();return}
  if(a==='week'){S.week=d.d==='0'?thisWeek():addDays(S.week,7*Number(d.d));render(true)}
  else if(a==='open')openEditor(d.id);
  else if(a==='new-post'){const pid=postId(S.week,d.line,d.pf),P=pfOf(d.pf);
    savePost(pid,{week:S.week,line:d.line,platform:d.pf,format:P.fmt,day:addDays(S.week,(st(d.line).dow||5)-1),hook:'',title:'',body:'',tags:[],media:'',assets:[],signals:[],out:'',url:'',status:'draft',ckLeak:false,ckMedia:false,ckFacts:false});
    openEditor(pid)}
  else if(a==='close-ed')ed.close();
  else if(a==='approve'&&p){if(gatesFor(p,edCopy()).every(x=>x.ok||x.na))savePost(id,{status:'approved',approvedAt:Date.now()})}
  else if(a==='publish'&&p){if(gatesFor(p).every(x=>x.ok||x.na))savePost(id,{status:'published',publishedAt:Date.now()})}
  else if(a==='to-draft'&&p)savePost(id,{status:'draft'});
  else if(a==='unpublish'&&p)savePost(id,{status:'approved'});
  else if(a==='del-post'&&p){if(await ask('删除这条内容？删掉之后找不回来。','删除')){ed.close();dropDoc('posts',id)}}
  else if(a==='copy-all'&&p)copy(fullCopy(p),'整条文案');
  else if(a==='copy-part'&&p)copy(d.k==='tags'?(p.tags||[]).join(' '):(p[d.k]||''),d.k==='tags'?'标签':'钩子');
  else if(a==='copy-brief'&&p)copy(briefFor({...p,...edCopy(),media:$('#ed [data-f="media"]').value}),'制作说明');
  else if(a==='filter'){S.assetFilter=d.v;render(true)}
  else if(a==='consent'){const x=S.assets.get(d.id);if(x&&(x.consent||'pending')!==d.v)saveDoc('assets',d.id,{consent:d.v,decidedAt:Date.now()})}
  else if(a==='del-asset'){const x=S.assets.get(d.id);if(x&&await ask(`把“${x.name}”从素材库移除？已经关联它的内容会自动去掉这个素材。`,'移除'))dropDoc('assets',d.id)}
  else if(a==='del-signal'){const x=S.signals.get(d.id);if(x&&await ask(`删除“${x.title}”？`,'删除'))dropDoc('signals',d.id)}
  else if(a==='connect'){try{const r=await api('connect-start',{brand:d.line,platform:d.pf});location.href=r.url}catch(err){toast(err.message)}}
  else if(a==='disconnect'){if(await ask('断开这个账号？之后这条线在这个平台只能手动发布。平台那边的授权，可以到平台的应用设置里移除。','断开')){try{await api('connect-disconnect',{brand:d.line,platform:d.pf});await refresh()}catch(err){toast(err.message)}}}
  else if(a==='pick-page'){try{await api('connect-select',{brand:d.line,platform:d.pf,id:d.id});await refresh();toast('已连接。')}catch(err){toast(err.message)}}
  else if(a==='media-preview'&&p){try{const r=await api('media-link',null,'&id='+encodeURIComponent(id));showMedia(r.url,r.type)}catch(err){toast(err.message)}}
  else if(a==='media-remove'&&p){if(await ask('移除这个成品？移除后要重新上传并确认。','移除')){try{const r=await api('media-remove',{postId:id});S.posts.set(id,r.doc);scheduleRender()}catch(err){toast(err.message)}}}
  else if(a==='native-publish'&&p)nativePublish(id,d.force==='1');
  else if(a==='del-brand'){const b=S.brands.get(d.id);if(b&&await ask(`删除“${b.name}”这条产品线？下面还有内容时删不掉。`,'删除'))dropDoc('brands',d.id)}
  else if(a==='del-term')saveSettings(d.line,{terms:(st(d.line).terms||[]).filter(x=>x!==d.t)});
  else if(a==='del-fact')saveSettings(d.line,{facts:(st(d.line).facts||[]).filter(x=>x.t!==d.t)});
});
document.addEventListener('change',e=>{
  const t=e.target,d=t.dataset;
  if(t.tagName==='SELECT')pointerDown=false;
  if(t.id==='ed-file'){if(t.files&&t.files[0])uploadMedia(t.files[0]);return}
  if(t.id==='import-file'){if(t.files&&t.files[0])importFile(t.files[0]);t.value='';return}
  if(d.brand){const b=S.brands.get(d.brand)||{},v=d.k==='dow'?Number(t.value):t.value.trim();if(v!==b[d.k]&&(d.k!=='name'||v))saveDoc('brands',d.brand,{[d.k]:v});return}
  if(t.closest('#ed')){
    const id=S.edit,p=id&&S.posts.get(id);if(!p)return;
    if(d.f){const f=d.f;let patch={};
      if(f==='tags'){const v=splitTags(t.value);if(v.join(' ')===(p.tags||[]).join(' '))return;patch.tags=v}
      else{const v=(f==='body'||f==='media')?t.value:t.value.trim();if(v===(p[f]||''))return;if(f==='url'&&v&&!safeUrl(v)){toast('链接要以 http:// 或 https:// 开头。');return}patch[f]=v}
      if(['hook','title','body','tags'].includes(f)){patch.ckLeak=false;if(p.status==='approved'){patch.status='draft';toast('文案改了，这条退回草稿，需要重新确认。')}}
      savePost(id,patch)}
    else if(d.pick){const cur=new Set(p[d.pick]||[]);t.checked?cur.add(t.value):cur.delete(t.value);savePost(id,{[d.pick]:[...cur],...(d.pick==='signals'?{ckFacts:false}:{})})}
    else if(d.ck)savePost(id,{[d.ck]:t.checked});
    return;
  }
  if(d.acc){const[line,pf]=d.acc.split('|');const v=d.k==='handle'?t.value.trim().replace(/^@+/,''):t.value;if(v===(acc(line,pf)[d.k]||(d.k==='status'?'none':'')))return;saveDoc('accounts',line+'_'+pf,{line,platform:pf,[d.k]:v})}
  else if(d.strict)saveSettings(d.strict,{strict:t.checked});
  else if(d.fact){const f=(st(d.fact).facts||[]).map(x=>x.t===d.t?{...x,ok:t.checked}:x);saveSettings(d.fact,{facts:f})}
  else if(d.repos)saveSettings(d.repos,{repos:t.value.split(/[,，\s]+/).map(x=>x.trim()).filter(Boolean).slice(0,12)});
  else if(d.angle){const s=S.signals.get(d.angle);if(s&&(s.angle||'')!==t.value.trim())saveDoc('signals',d.angle,{angle:t.value.trim()})}
});
document.addEventListener('input',e=>{if(e.target.closest('#ed')&&e.target.dataset.f)refreshEditor(e.target)});
document.addEventListener('submit',e=>{
  const f=e.target,k=f.dataset.form;if(!k)return;e.preventDefault();
  const v=Object.fromEntries(new FormData(f).entries()),line=f.dataset.line;
  if(k==='brand'){const name=str(v.name,60).trim();if(!name)return;
    let id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24)||'line';
    while(S.brands.has(id))id=id.slice(0,24)+'-'+Math.random().toString(36).slice(2,5);
    saveDoc('brands',id,{name,scope:str(v.scope,120).trim(),color:v.color,order:Date.now()});f.reset()}
  else if(k==='term'){const t=str(v.t,60).trim();if(!t)return;const cur=st(line).terms||[];if(!cur.some(x=>x.toLowerCase()===t.toLowerCase()))saveSettings(line,{terms:[...cur,t]});f.reset()}
  else if(k==='fact'){const t=str(v.t,120).trim();if(!t)return;const cur=st(line).facts||[];if(!cur.some(x=>x.t===t))saveSettings(line,{facts:[...cur,{t,ok:false}]});f.reset()}
  else if(k==='asset'){const name=str(v.name,80).trim();if(!name)return;const where=str(v.where,300).trim();
    saveDoc('assets',newId('a_'),{line:v.line,kind:v.kind,name,where,url:safeUrl(where),desc:str(v.desc,300).trim(),consent:'pending',addedAt:Date.now()});f.reset();toast('已加入素材库，状态是“待你决定”。')}
  else if(k==='signal'){const title=str(v.title,120).trim();if(!title)return;
    saveDoc('signals',newId('s_'),{week:S.week,line,kind:v.kind==='trend'?'trend':'repo',title,detail:str(v.detail,400).trim(),source:str(v.source,80).trim(),url:safeUrl(v.url),angle:'',verify:true,date:iso(new Date())});f.reset()}
  render(true);
});
function route(){const h=location.hash.replace('#','');S.view=VIEWS[h]?h:'week'}
window.addEventListener('hashchange',()=>{route();render(true);window.scrollTo(0,0)});

/* 启动 */
function loadScript(src,key){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.async=true;s.crossOrigin='anonymous';
  if(key)s.setAttribute('data-clerk-publishable-key',key);
  const timer=setTimeout(()=>{s.remove();reject(Error('timeout'))},60000);
  s.onload=()=>{clearTimeout(timer);resolve()};s.onerror=()=>{clearTimeout(timer);reject(Error('load'))};document.head.append(s)})}
function mountSignIn(){
  const el=$('#signin');if(!el||!S.clerk||el.dataset.mounted)return;el.dataset.mounted='1';
  // 邀请链接带着 __clerk_ticket：新成员走注册，已有账号的走登录。登录组件用 hash 路由，和 World Builder 一样。
  const q=new URLSearchParams(location.search),home=location.origin+'/';
  const signup=q.has('__clerk_ticket')?q.get('__clerk_status')!=='sign_in':location.pathname==='/sign-up';
  if(signup)S.clerk.mountSignUp(el,{routing:'hash',forceRedirectUrl:home,signInForceRedirectUrl:home});
  else S.clerk.mountSignIn(el,{routing:'hash',forceRedirectUrl:home,signUpForceRedirectUrl:home});
}
const deniedView=()=>S.denied==='invite'
  ?`<section class="card"><h3>这个账号还没有开通</h3><p>这个发布台目前只对指定的账号或团队开放。把下面的编号发给管理员，加进允许名单之后就能用；如果你属于已开通的团队，在右上角切换到那个团队。</p><p class="num">${esc([S.clerk?.organization?.id,S.clerk?.user?.id].filter(Boolean).join(' · '))}</p></section>`
  :`<section class="card"><h3>登录没有通过校验</h3><p>${esc(S.denied||'请重新登录。')}</p><p class="muted">如果刚部署好就看到这一条：检查环境变量 LUMI_PUBLISH_ORIGIN 是不是和你现在打开的网址完全一致（包括 https 和域名），以及 CLERK_PUBLISHABLE_KEY 是不是这个站点用的那一个。</p><div class="row"><button class="btn" data-act="reload">重新加载</button></div></section>`;
const setupView=()=>`<section class="card"><h3>还差几步配置</h3><p>部署已经在运行，但下面这些环境变量还没有填好。填完重新部署一次就能用。</p><ul class="todo">${S.missing.map(m=>`<li>${esc(m)}</li>`).join('')}</ul></section>`;
// 和 World Builder 用同一种方式加载 Clerk：两段脚本都来自你自己的 Clerk 实例域名。
async function startClerk(cfg){
  await Promise.all([loadScript(`${cfg.issuer}/npm/@clerk/ui@1/dist/ui.browser.js`),loadScript(`${cfg.issuer}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,cfg.publishableKey)]);
  const clerk=window.Clerk;
  await clerk.load({ui:{ClerkUI:window.__internal_ClerkUICtor},signInUrl:location.origin+'/sign-in',signUpUrl:location.origin+'/sign-up',afterSignOutUrl:location.origin+'/sign-in',
    appearance:{variables:{colorPrimary:'#151821',borderRadius:'10px'}}});
  S.clerk=clerk;
  const keyOf=()=>`${clerk.user?.id||''}|${clerk.organization?.id||''}`;
  let seen=keyOf();
  // 换了人或换了组织，就整页重来，绝不把上一个租户的数据留在页面里。
  clerk.addListener(()=>{if(keyOf()!==seen){seen=keyOf();location.reload()}});
  if(!clerk.user||!clerk.session)return false;
  // 登录完成后回到首页，去掉登录用过的路径和一次性参数。
  if(/^\/sign-(in|up)/.test(location.pathname)||new URLSearchParams(location.search).has('__clerk_ticket'))history.replaceState(null,'','/');
  try{clerk.mountOrganizationSwitcher($('#org-switch'),{hidePersonal:false,afterSelectOrganizationUrl:location.pathname,afterSelectPersonalUrl:location.pathname})}
  catch(e){/* 这个 Clerk 实例没开 Organizations：只有个人空间，照常可用 */}
  clerk.mountUserButton($('#user-btn'));
  return true;
}
function flashConnect(){
  const q=new URLSearchParams(location.search),c=q.get('connect');if(!c)return;
  const P=pfOf(q.get('platform')).name;
  toast({ok:`${P} 已连接。`,pick:'再选一下要连到这条线的主页。',denied:'你取消了授权，没有连接。',expired:'这次授权超时了，重新点一次“连接”。',
    no_page:'这个 Facebook 账号下没有可以管理的主页。内容只能发到主页。',no_channel:'这个 Google 账号下没有 YouTube 频道。',
    no_refresh:'Google 没有给长期授权。到 Google 账号的第三方应用里移除本应用，再重新连接。'}[c]||`${P} 没有连接成功，稍后再试。`);
  q.delete('connect');q.delete('platform');const rest=q.toString();
  history.replaceState(null,'',location.pathname+(rest?'?'+rest:'')+location.hash);
}
async function boot(){
  route();render();
  let cfg;
  try{cfg=await (await fetch('/api/app?do=config',{cache:'no-store'})).json()}catch(e){S.host='down';render();return}
  S.dev=!!cfg.dev;
  if(!cfg.configured){S.host='setup';S.missing=cfg.missing||[];render();return}
  if(!S.dev){
    let signedIn=false;
    try{signedIn=await startClerk(cfg)}catch(e){S.host='down';S.denied='signin';render();return}
    if(!signedIn){S.host='signin';render();return}
  }else $('#org-switch').innerHTML='<span class="flag plain">本地开发</span>';
  S.host='ready';
  await refresh();
  flashConnect();
  // 页面在前台时每分钟看一次别人有没有改动；切回这个标签页时立刻看一次。
  setInterval(()=>{if(document.visibilityState==='visible')refresh()},60000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh()});
}
boot();
