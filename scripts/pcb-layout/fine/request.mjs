import { scopeLayoutModel } from '../pcb-layout-scope.mjs';
import { fail, finiteBox, within, digest } from './common.mjs';

const fields = (value, allowed, code) => { if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))fail(code); };
const refs = (value, model, name) => { if(!Array.isArray(value)||new Set(value).size!==value.length||value.some(r=>!model.components.has(r)))fail('FINE_INVALID_REFS',name);return [...value]; };
export function normalizeFineRequest(model, input) {
  fields(input,['schemaVersion','blockId','movableRefs','allowedNeighborRefs','fixedRefs','releaseFixedRefs','region','reservedRegions','relations','labels','baselinePolicy','routing','objective'],'FINE_INVALID_REQUEST');
  if(input.schemaVersion!==1)fail('FINE_REQUEST_VERSION');
  const block=input.blockId?model.contract.blocks.find(b=>b.id===input.blockId):null;
  if(input.blockId&&!block)fail('FINE_UNKNOWN_BLOCK',input.blockId);
  const primary=refs(input.movableRefs,model,'movableRefs'),neighbors=refs(input.allowedNeighborRefs??[],model,'allowedNeighborRefs'),fixed=refs(input.fixedRefs??[],model,'fixedRefs');
  if(!primary.length||primary.some(r=>neighbors.includes(r)||fixed.includes(r))||neighbors.some(r=>fixed.includes(r)))fail('FINE_SCOPE_CONFLICT');
  if(block&&primary.some(r=>!block.components.includes(r)))fail('FINE_PRIMARY_OUTSIDE_BLOCK');
  const movableRefs=[...primary,...neighbors],moving=new Set(movableRefs);
  const releaseFixedRefs=refs(input.releaseFixedRefs??[],model,'releaseFixedRefs');
  if(releaseFixedRefs.some(r=>!moving.has(r)))fail('FINE_RELEASE_OUTSIDE_MOVABLE');
  // Retain ALL components, pads, crossing relations and native lock provenance.
  const scoped=scopeLayoutModel(model,{includeLabels:true,releaseFixedRefs});
  for(const ref of movableRefs)if(scoped.fixed.has(ref))fail('FINE_LOCKED_MOVABLE',ref+' '+JSON.stringify(scoped.lockProvenance.get(ref)));
  for(const item of model.snapshot.items)if(item.locked&&moving.has(item.owner))fail('FINE_LOCKED_LABEL_OWNER',item.owner);
  for(const p of model.snapshot.pads)if(p.locked&&moving.has(p.owner))fail('FINE_LOCKED_COMPONENT_PAD',p.owner);
  // Explicit fixed refs are already outside the movable set: compilation fixes
  // their exact source poses and acceptance checks preservation. Do not turn a
  // raw native angle (e.g. -90) into a second hard.fixed source/domain constraint.
  for(const ref of fixed)scoped.lockProvenance.set(ref,[...(scoped.lockProvenance.get(ref)??[]),'fine.request.fixed']);
  const board=model.config.hard.boardBounds;
  if(!finiteBox(board))fail('FINE_REAL_BOARD_REQUIRED');
  fields(input.region,['mode','boundsMil','referenceBoundsMil','basis'],'FINE_INVALID_REGION');
  if(!['window','available-space'].includes(input.region.mode)||typeof input.region.basis!=='string'||!input.region.basis.trim())fail('FINE_REGION_POLICY_REQUIRED');
  const bounds=input.region.boundsMil??(input.region.mode==='available-space'?board:null);
  if(!finiteBox(bounds)||!within(bounds,board))fail('FINE_REGION_OUTSIDE_BOARD');
  const reference=input.region.referenceBoundsMil;
  if(reference!==undefined&&(!finiteBox(reference)||!within(reference,board)))fail('FINE_INVALID_REFERENCE_REGION');
  const labels=input.labels??{mode:'separate'};
  fields(labels,['mode','clearanceMil','maxOwnerDistanceMil','maxSeconds'],'FINE_INVALID_LABEL_POLICY');
  if(!['joint','separate'].includes(labels.mode))fail('FINE_LABEL_MODE_UNSUPPORTED');
  for(const key of ['clearanceMil','maxOwnerDistanceMil','maxSeconds'])if(labels[key]!==undefined&&(!Number.isFinite(labels[key])||labels[key]<0||(key==='maxSeconds'&&labels[key]===0)))fail('FINE_INVALID_LABEL_POLICY',key);
  const baselinePolicy=input.baselinePolicy??'require-clean';
  if(!['require-clean','retain-outside-issues'].includes(baselinePolicy))fail('FINE_BASELINE_POLICY');
  const pad=spec=>{
    fields(spec,['ref','pin','padId'],'FINE_INVALID_ENDPOINT');
    const found=model.pads.filter(p=>spec.padId?p.id===spec.padId:p.owner===spec.ref&&String(p.number)===String(spec.pin));
    if(found.length!==1)fail('FINE_ENDPOINT_NOT_UNIQUE',JSON.stringify(spec));
    if(spec.padId&&(spec.ref!==undefined&&spec.ref!==(found[0].owner??found[0].number)||spec.pin!==undefined&&String(spec.pin)!==String(found[0].number)))fail('FINE_ENDPOINT_IDENTITY_MISMATCH');
    return found[0];
  };
  if(!Array.isArray(input.relations??[]))fail('FINE_INVALID_RELATIONS');
  const ids=new Set();
  const relations=(input.relations??[]).map(r=>{
    fields(r,['id','from','to','net','basis','source','weight','maxDistanceMil','nonRegression','critical'],'FINE_INVALID_RELATION');
    if(typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.basis!=='string'||!r.basis.trim())fail('FINE_RELATION_ID_OR_BASIS');ids.add(r.id);
    const a=pad(r.from),b=pad(r.to);
    if(a.net!==b.net||(r.net!==undefined&&a.net!==r.net))fail('FINE_RELATION_NET_MISMATCH',r.id);
    if(!moving.has(a.owner)&&!moving.has(b.owner))fail('FINE_RELATION_OUTSIDE_MOVABLE',r.id);
    if(r.weight!==undefined&&(!Number.isFinite(r.weight)||r.weight<0))fail('FINE_INVALID_WEIGHT',r.id);
    if(r.maxDistanceMil!==undefined&&(!Number.isFinite(r.maxDistanceMil)||r.maxDistanceMil<0))fail('FINE_INVALID_DISTANCE_CAP',r.id);
    if(r.nonRegression!==undefined){fields(r.nonRegression,['toleranceMil'],'FINE_INVALID_NON_REGRESSION');if(!Number.isFinite(r.nonRegression.toleranceMil)||r.nonRegression.toleranceMil<0)fail('FINE_INVALID_NON_REGRESSION',r.id);}
    if(r.critical!==undefined&&typeof r.critical!=='boolean')fail('FINE_INVALID_CRITICAL',r.id);
    return {...r,net:a.net,from:{ref:a.owner??a.number,pin:String(a.number),padId:a.id},to:{ref:b.owner??b.number,pin:String(b.number),padId:b.id},weight:r.weight??0};
  });
  if(!Array.isArray(input.reservedRegions??[]))fail('FINE_INVALID_RESERVATIONS');
  const reservedRegions=(input.reservedRegions??[]).map(r=>{
    fields(r,['id','boundsMil','geometry','basis'],'FINE_INVALID_RESERVATION');
    if(!r.id||!r.basis||!finiteBox(r.boundsMil)||!within(r.boundsMil,board)||!['physical','assembly','placement'].includes(r.geometry??'physical'))fail('FINE_INVALID_RESERVATION',r.id);
    return {...r,geometry:r.geometry??'physical'};
  });
  if(new Set(reservedRegions.map(r=>r.id)).size!==reservedRegions.length)fail('FINE_DUPLICATE_RESERVATION');
  const routing=input.routing??{required:false};
  fields(routing,['required','policy','options','nets'],'FINE_INVALID_ROUTING');
  if(typeof routing.required!=='boolean'||routing.nets!==undefined&&(!Array.isArray(routing.nets)||new Set(routing.nets).size!==routing.nets.length||routing.nets.some(n=>!model.pads.some(p=>p.net===n))))fail('FINE_INVALID_ROUTING');
  const objective=input.objective??{retainSource:true};fields(objective,['retainSource'],'FINE_INVALID_OBJECTIVE');
  if(typeof objective.retainSource!=='boolean')fail('FINE_INVALID_OBJECTIVE');
  const frozenRefs=[...model.components.keys()].filter(r=>!moving.has(r));
  const lockSources=Object.fromEntries(frozenRefs.map(ref=>[ref,[...(scoped.lockProvenance.get(ref)??[]),...(fixed.includes(ref)?[]:['fine.scope.context'])]]));
  const actualNets=new Map();for(const p of model.pads){if(!actualNets.has(p.net))actualNets.set(p.net,[]);actualNets.get(p.net).push(p);}
  const crossingNets=[...actualNets].filter(([,pads])=>pads.some(p=>moving.has(p.owner))&&pads.some(p=>!moving.has(p.owner))).map(([net,pads])=>({net,endpoints:pads.map(p=>({ref:p.owner??null,pin:String(p.number),padId:p.id,standalone:!p.owner,movable:moving.has(p.owner),x:p.x,y:p.y}))}));
  return {model:scoped,request:{schemaVersion:1,blockId:input.blockId??null,movableRefs:primary,allowedNeighborRefs:neighbors,allMovableRefs:movableRefs,fixedRefs:fixed,releaseFixedRefs,region:{...input.region,boundsMil:{...bounds}},labels,baselinePolicy,reservedRegions,relations,routing,objective},moving,frozenRefs,lockSources,crossingNets,inputHash:digest(input)};
}
