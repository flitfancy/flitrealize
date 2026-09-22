import {escapeHtml as esc,prose} from './format.mjs';
import {navigation,sourceUrl} from './navigation.mjs';
import {displayTitle} from './names.mjs';
import {renderNetworkTable} from './network-table.mjs';
const $=id=>document.getElementById(id);
const storage={get(key){try{return localStorage.getItem(key);}catch{return null;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
const state={root:new URLSearchParams(location.search).get('projectRoot')||storage.get('view-state.projectRoot')||'',lang:storage.get('view-state.lang')||'en',snapshot:null,open:new Set(),error:'',controller:null,signature:''};
const tr=(zh,en)=>state.lang==='en'?en:zh;
const bridgeWords={
  ready:['已连接','Connected'],'bridge-ready':['EDA 未连接','No EDA'],
  unreachable:['未响应','Unreachable'],incompatible:['不兼容','Incompatible'],
  'session-mismatch':['会话异常','Mismatch'],unknown:['未知','Unknown'],
};
const title=node=>displayTitle(node,state.lang);
function bridgeState(){return state.error?'unknown':state.snapshot?.bridge?.state||'unknown';}
function bridgeLabel(){return tr(...(bridgeWords[bridgeState()]||bridgeWords.unknown));}
function openProject(){ $('projectRoot').value=state.root; $('projectDialog').showModal(); }
function source(node,label=tr('阅读全文','Read source')){
  return '<a class="source-link" target="_blank" rel="noopener" href="'+esc(sourceUrl(state.root,node))+'">'+esc(label)+' ↗</a>';
}
function chrome(){
  document.documentElement.lang=state.lang==='en'?'en':'zh-CN';
  $('langBtn').textContent=tr('EN','中文');
  $('langBtn').title=tr('显示英文名称','Show Chinese labels');
  $('projectLabel').textContent=tr('当前项目','CURRENT PROJECT');
  $('projectName').textContent=state.snapshot?.projectName||state.root.split(/[\\/]/).filter(Boolean).at(-1)||tr('选择项目','Choose project');
  $('projectBtn').title=state.root||tr('切换项目目录','Change project directory');
  $('runtimeBtn').innerHTML='<i class="dot '+esc(bridgeState())+'"></i>'+tr('桥接','Bridge');
  $('runtimeBtn').title=tr('桥接：','Bridge: ')+bridgeLabel();
  $('runtimeBtn').setAttribute('aria-label',tr('桥接：','Bridge: ')+bridgeLabel());
  $('treeLabel').textContent=tr('项目阶段','PROJECT STAGES');
  $('collapseBtn').textContent=tr('全部收起','Collapse all');
  $('collapseBtn').disabled=state.open.size===0;
  $('fullDocument').textContent=tr('交接文稿 ↗','Handoff ↗');
  if(state.snapshot?.documentExists)$('fullDocument').href=sourceUrl(state.root,null);
  else $('fullDocument').removeAttribute('href');
  $('footerNote').textContent=tr('文稿更新','Document updated');
  const updated=state.snapshot?.updatedAt||'';
  const date=new Date(updated);
  $('updateTime').textContent=updated.includes('T')&&!Number.isNaN(date.getTime())
    ?new Intl.DateTimeFormat(state.lang==='en'?'en-GB':'zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):updated||'—';
  $('updateTime').title=tr('文稿记录的更新时间：','Document update time: ')+updated;
  $('banner').hidden=!state.error;
  $('banner').textContent=state.error+(state.snapshot?tr('。保留上次成功读取的内容。',' Previous content retained.'):'');
  $('projectDialogTitle').textContent=tr('打开项目','Open project');
  $('projectHelp').textContent=tr('选择含 CURRENT_HANDOFF.md 的项目目录。','Choose a directory containing CURRENT_HANDOFF.md.');
  $('pathLabel').textContent=tr('项目绝对路径','Absolute project path');
  $('openProjectBtn').textContent=tr('打开项目 →','Open project →');
  $('bridgeTitle').textContent=tr('桥接状态','Bridge status');
  $('bridgeInfo').textContent=bridgeLabel()+(state.snapshot?.bridge?.port?' · 127.0.0.1:'+state.snapshot.bridge.port:'')+'。'+tr('连接状态不表示已核对当前项目设计。','Connection does not verify the current project design.');
  document.querySelectorAll('[data-bridge-label]').forEach(el=>{el.textContent=bridgeLabel();});
  document.querySelectorAll('[data-bridge-port]').forEach(el=>{el.textContent=state.snapshot?.bridge?.port?'127.0.0.1:'+state.snapshot.bridge.port:tr('未提供','Not provided');});
}
function field(label,value){return '<div class="field"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong></div>';}
function content(node){
  if(node.kind==='overview')return field(tr('当前阶段','Current stage'),state.snapshot?.currentStage||tr('未提供','Not provided'))+source(null);
  if(node.kind==='mode')return '<p class="empty">'+tr('当前模式未提供。由 skill 明确记录 DEFAULT_MODE 或 CURIOUS_MODE 后再展示。','Current mode is not provided. The skill must explicitly supply DEFAULT_MODE or CURIOUS_MODE.')+'</p>'+source(null);
  if(node.kind==='bridge')return '<div class="field"><span>'+tr('连接','Connection')+'</span><strong data-bridge-label>'+esc(bridgeLabel())+'</strong></div><div class="field"><span>'+tr('地址','Address')+'</span><strong data-bridge-port></strong></div><p class="empty">'+tr('桥接连通不代表已核对当前工程。','A live bridge does not verify the current project.')+'</p>';
  const inventory=node.kind==='parts'?field(tr('库存匹配','Inventory match'),tr('未提供','Not provided')):'';
  if(!node.sources.length){
    return inventory+'<p class="empty">'+tr('交接中尚未提供这一项的记录。','No record for this item in the handoff yet.')+'</p>'+source(null);
  }
  if(node.kind==='networks'){
    const tables=node.sources.filter(n=>n.networkTable);
    if(!tables.length)return renderNetworkTable(null,state.lang)+node.sources.map(n=>source(n,n.title)).join('');
    return tables.map(n=>'<section class="source-paragraph">'+(tables.length>1?'<h3>'+esc(n.title)+'</h3>':'')+
      (n.summary?'<p class="network-note">'+prose(n.summary)+'</p>':'<p class="empty">'+tr('数据依据未说明，请查看原文。','Data basis not described; see the source.')+'</p>')+
      renderNetworkTable(n.networkTable,state.lang)+source(n)+'</section>').join('')+
      node.sources.filter(n=>!n.networkTable).map(n=>source(n,n.title)).join('');
  }
  return inventory+node.sources.map(n=>'<section class="source-paragraph">'+(node.sources.length>1?'<h3>'+esc(n.title)+'</h3>':'')+(n.summary?'<p class="synopsis">'+prose(n.summary)+'</p>':'<p class="empty">'+tr('这一节尚未提供梗概。','No summary in this section yet.')+'</p>')+source(n)+'</section>').join('');
}
function item(node){
  const isRuntime=['mode','bridge','overview'].includes(node.kind);
  const badge=node.kind==='bridge'?'<span class="item-status" data-bridge-label>'+esc(bridgeLabel())+'</span>':
    node.kind==='mode'?'<span class="item-status">'+tr('未提供','Not provided')+'</span>':
    node.kind==='overview'?'':'<span class="item-status" title="'+tr('阶段状态须由 skill 明确提供；不从正文推断','The skill must explicitly supply progress status')+'">'+(node.sources.length?'—':tr('未记录','No record'))+'</span>';
  return '<details class="skill-item" data-key="'+node.id+'" '+(state.open.has(node.id)?'open':'')+'><summary><span class="item-code">'+node.code+'</span><span class="item-title">'+esc(title(node))+'</span>'+badge+'<span class="item-chevron" aria-hidden="true">›</span></summary><div class="item-body">'+content(node)+(!isRuntime&&node.sources.length?field(tr('工程状态','Progress status'),tr('未提供','Not provided')):'')+'</div></details>';
}
function render(){
  const scroll=$('stages').scrollTop;
  const focused=document.activeElement?.closest('details')?.dataset.key;
  const roots=navigation(state.snapshot);
  $('stages').innerHTML=roots.map(group=>'<details class="stage-group'+(group.current?' current':'')+'" data-key="'+group.id+'" '+(state.open.has(group.id)?'open':'')+'><summary><span class="group-code">'+group.code+'</span><span class="group-title">'+esc(title(group))+'</span>'+(group.current?'<span class="current-mark">'+tr('当前','NOW')+'</span>':'')+'<span class="chevron" aria-hidden="true">›</span></summary><div class="group-items">'+group.children.map(item).join('')+'</div></details>').join('')+
    (!roots.length?'<p class="empty">'+tr('选择项目，查看 skill 阶段树。','Choose a project to view the skill tree.')+'</p><button class="primary" data-project>'+tr('打开项目','Open project')+'</button>':'')+
    (state.snapshot&&!state.snapshot.documentExists?'<p class="empty">'+tr('此项目尚无交接文稿。','No handoff document exists.')+'</p>':'')+
    (state.snapshot?.issues.length?'<p class="empty">'+tr('交接梗概、表格或阶段格式有误，请检查原文。','Check the source: invalid summaries, tables or stage markers.')+'</p>':'');
  chrome();
  $('stages').scrollTop=scroll;
  if(focused)[...$('stages').querySelectorAll('details')].find(el=>el.dataset.key===focused)?.querySelector('summary')?.focus({preventScroll:true});
}
async function load({switching=false}={}){
  if(state.controller&&!switching)return;
  state.controller?.abort();
  const controller=new AbortController();state.controller=controller;
  const timer=setTimeout(()=>controller.abort(),10000);
  if(switching){state.snapshot=null;state.signature='';state.open.clear();state.error='';render();$('stages').scrollTop=0;}
  $('refreshBtn').disabled=true;
  try{
    const response=await fetch('/api/status?'+new URLSearchParams({projectRoot:state.root}),{signal:controller.signal,cache:'no-store'});
    const body=await response.json();
    if(!response.ok)throw new Error(body.message||body.error||response.status);
    if(state.controller!==controller)return;
    if(body.error==='NO_PROJECT_ROOT'){state.snapshot=null;state.error='';render();return;}
    if(body.schemaVersion!==2||!Array.isArray(body.sections))throw new Error(tr('数据格式不匹配，请重启 VS 服务','Data format mismatch; restart the VS server'));
    const recovered=Boolean(state.error);state.error='';state.snapshot=body;state.root=body.projectRoot;
    storage.set('view-state.projectRoot',state.root);
    const signature=JSON.stringify([body.sections,body.currentStage,body.currentId,body.updatedAt,body.projectName,body.documentExists,body.issues]);
    if(signature!==state.signature||recovered){state.signature=signature;render();}else chrome();
  }catch(e){
    if(state.controller!==controller)return;
    state.error=e.name==='AbortError'?tr('读取超时','Read timed out'):e.message;render();
  }finally{clearTimeout(timer);if(state.controller===controller){state.controller=null;$('refreshBtn').disabled=false;}}
}
$('stages').addEventListener('toggle',e=>{
  const el=e.target;
  // Ignore queued toggle events from DOM removed by a refresh.
  if(el instanceof HTMLDetailsElement&&el.isConnected){el.open?state.open.add(el.dataset.key):state.open.delete(el.dataset.key);$('collapseBtn').disabled=state.open.size===0;}
},true);
document.addEventListener('click',e=>{if(e.target.closest('[data-project]'))openProject();});
$('stages').addEventListener('click',e=>{
  const summary=e.target.closest('summary');
  const item=summary?.parentElement;
  if(!item?.classList.contains('skill-item')||item.open)return;
  requestAnimationFrame(()=>{
    if(!item.isConnected||!item.open)return;
    const viewport=$('stages').getBoundingClientRect();
    const bounds=item.getBoundingClientRect();
    if(bounds.bottom>viewport.bottom||bounds.top<viewport.top){
      $('stages').scrollTo({top:$('stages').scrollTop+bounds.top-viewport.top-44,
        behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    }
  });
});
$('projectBtn').onclick=openProject;
$('closeProject').onclick=()=>$('projectDialog').close();
$('projectForm').onsubmit=e=>{e.preventDefault();state.root=$('projectRoot').value.trim();$('projectDialog').close();const url=new URL(location.href);url.searchParams.set('projectRoot',state.root);history.replaceState(null,'',url);load({switching:true});};
$('refreshBtn').onclick=()=>load();
$('collapseBtn').onclick=()=>{state.open.clear();render();$('stages').scrollTop=0;};
$('langBtn').onclick=()=>{state.lang=state.lang==='zh'?'en':'zh';storage.set('view-state.lang',state.lang);render();};
$('runtimeBtn').onclick=()=>{chrome();$('bridgeDialog').showModal();};
$('closeBridge').onclick=()=>$('bridgeDialog').close();
render();load();
setInterval(()=>{if(document.visibilityState==='visible')load();},5000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')load();});
