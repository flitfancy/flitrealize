import { scopeLayoutModel } from '../pcb-layout-scope.mjs';
import { fail, finiteBox, within, digest } from './common.mjs';

const fields = (value, allowed, code) => { if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k)))fail(code); };
const refs = (value, model, name) => { if(!Array.isArray(value)||new Set(value).size!==value.length||value.some(r=>!model.components.has(r)))fail('FINE_INVALID_REFS',name);return [...value]; };
export function normalizeFineRequest(model, input) {
  fields(input,['schemaVersion','blockId','movableRefs','allowedNeighborRefs','allowedNeighborBlockIds','fixedRefs','releaseFixedRefs','region','reservedRegions','relations','relationSelection','labels','baselinePolicy','routing','objective'],'FINE_INVALID_REQUEST');
  if(input.schemaVersion!==1)fail('FINE_REQUEST_VERSION');
  const block=input.blockId?model.contract.blocks.find(b=>b.id===input.blockId):null;
  if(input.blockId&&!block)fail('FINE_UNKNOWN_BLOCK',input.blockId);
  const fixed=refs(input.fixedRefs??[],model,'fixedRefs'),explicitNeighbors=refs(input.allowedNeighborRefs??[],model,'allowedNeighborRefs');
  const releaseFixedRefs=refs(input.releaseFixedRefs??[],model,'releaseFixedRefs');
  // Retain the full model and every lock source before deriving permissions.
  const scoped=scopeLayoutModel(model,{includeLabels:true,releaseFixedRefs});
  const excluded=[];
  const selectBlock=(b,role)=>b.components.filter(ref=>{
    const sources=[...(scoped.fixed.has(ref)?scoped.lockProvenance.get(ref)??['legacy.unknown']:[]),...(fixed.includes(ref)?['fine.request.fixed']:[]),...(model.snapshot.pads.some(p=>p.locked&&p.owner===ref)?['snapshot.pad.locked']:[])];
    if(!model.components.has(ref))sources.push('fixed-standalone-pad');
    if(sources.length){excluded.push({role,blockId:b.id,ref,sources});return false;}
    return true;
  });
  if(input.movableRefs===undefined&&!block)fail('FINE_BLOCK_OR_MOVABLE_REQUIRED');
  const primary=input.movableRefs===undefined?selectBlock(block,'primary'):refs(input.movableRefs,model,'movableRefs');
  const allowedNeighborBlockIds=input.allowedNeighborBlockIds??[];
  if(!Array.isArray(allowedNeighborBlockIds)||new Set(allowedNeighborBlockIds).size!==allowedNeighborBlockIds.length)fail('FINE_INVALID_NEIGHBOR_BLOCKS');
  const neighborBlocks=allowedNeighborBlockIds.map(id=>{
    const b=model.contract.blocks.find(b=>b.id===id);
    if(!b)fail('FINE_UNKNOWN_NEIGHBOR_BLOCK',id);
    if(id===input.blockId)fail('FINE_NEIGHBOR_BLOCK_SCOPE_CONFLICT',id);
    return b;
  });
  const neighbors=[...new Set([...explicitNeighbors,...neighborBlocks.flatMap(b=>selectBlock(b,'neighbor'))])];
  if(!primary.length||primary.some(r=>neighbors.includes(r)||fixed.includes(r))||neighbors.some(r=>fixed.includes(r)))fail('FINE_SCOPE_CONFLICT');
  if(block&&primary.some(r=>!block.components.includes(r)))fail('FINE_PRIMARY_OUTSIDE_BLOCK');
  const movableRefs=[...primary,...neighbors],moving=new Set(movableRefs);
  if(releaseFixedRefs.some(r=>!moving.has(r)))fail('FINE_RELEASE_OUTSIDE_MOVABLE');
  for(const ref of movableRefs)if(scoped.fixed.has(ref))fail('FINE_LOCKED_MOVABLE',ref+' '+JSON.stringify(scoped.lockProvenance.get(ref)));
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
  fields(labels,['mode','clearanceMil','maxOwnerDistanceMil','maxSeconds','additionalOwnerRefs'],'FINE_INVALID_LABEL_POLICY');
  if(!['joint','separate'].includes(labels.mode))fail('FINE_LABEL_MODE_UNSUPPORTED');
  const additionalOwnerRefs=refs(labels.additionalOwnerRefs??[],model,'labels.additionalOwnerRefs');
  if(additionalOwnerRefs.length&&labels.mode!=='separate')fail('FINE_SEPARATE_LABEL_SCOPE_REQUIRED');
  const labelMoving=new Set([...movableRefs,...additionalOwnerRefs]);
  for(const item of model.snapshot.items)if(item.locked&&labelMoving.has(item.owner))fail('FINE_LOCKED_LABEL_OWNER',item.owner);
  for(const key of ['clearanceMil','maxOwnerDistanceMil','maxSeconds'])if(labels[key]!==undefined&&(!Number.isFinite(labels[key])||labels[key]<0||(key==='maxSeconds'&&labels[key]===0)))fail('FINE_INVALID_LABEL_POLICY',key);
  const baselinePolicy=input.baselinePolicy??'require-clean';
  if(!['require-clean','retain-outside-issues'].includes(baselinePolicy))fail('FINE_BASELINE_POLICY');
  const objective=input.objective??{retainSource:true};fields(objective,['retainSource'],'FINE_INVALID_OBJECTIVE');
  if(typeof objective.retainSource!=='boolean')fail('FINE_INVALID_OBJECTIVE');
  const pad=spec=>{
    fields(spec,['ref','pin','padId'],'FINE_INVALID_ENDPOINT');
    const found=model.pads.filter(p=>spec.padId?p.id===spec.padId:p.owner===spec.ref&&String(p.number)===String(spec.pin));
    if(found.length!==1)fail('FINE_ENDPOINT_NOT_UNIQUE',JSON.stringify(spec));
    if(spec.padId&&(spec.ref!==undefined&&spec.ref!==(found[0].owner??found[0].number)||spec.pin!==undefined&&String(spec.pin)!==String(found[0].number)))fail('FINE_ENDPOINT_IDENTITY_MISMATCH');
    return found[0];
  };
  if(!Array.isArray(input.relations??[]))fail('FINE_INVALID_RELATIONS');
  const relationSelection=input.relationSelection??'explicit';
  if(!['explicit','scope'].includes(relationSelection))fail('FINE_RELATION_SELECTION');
  if(relationSelection==='scope'&&!objective.retainSource)fail('FINE_BASE_OBJECTIVE_DISABLED','scope relation selection');
  const overrides=new Set((input.relations??[]).map(r=>r?.relationId).filter(id=>id!==undefined));
  const derived=relationSelection==='scope'?(model.preparedRelations??[]).filter(base=>{
    const binding=base.implements?.find(i=>i.type==='pin-distance-objective'),link=model.links.find(l=>l.id===binding?.objectiveId);
    return base.status==='compiled'&&!overrides.has(base.id)&&link&&[...link.left,...link.right].some(p=>moving.has(p.owner));
  }).map(base=>({relationId:base.id})):[];
  const ids=new Set(),baseIds=new Set();
  const relations=[...derived,...(input.relations??[])].map(original=>{
    fields(original,['id','from','to','net','basis','source','weight','maxDistanceMil','nonRegression','critical','relationId','merge','geometry'],'FINE_INVALID_RELATION');
    const r={...original};let composition;
    if(r.relationId!==undefined){
      const base=model.preparedRelations?.find(b=>b.id===r.relationId&&b.status==='compiled');
      if(!base)fail('FINE_UNKNOWN_BASE_RELATION',r.relationId);
      if(baseIds.has(r.relationId))fail('FINE_DUPLICATE_BASE_RELATION',r.relationId);baseIds.add(r.relationId);
      if(!objective.retainSource)fail('FINE_BASE_OBJECTIVE_DISABLED',r.relationId);
      r.id??=r.relationId;r.basis??=base.basis;r.merge??='inherit';r.geometry??='pad-position';
      if(!['inherit','replace-objective','append-objective'].includes(r.merge))fail('FINE_INVALID_RELATION_MERGE',r.id);
      if(r.merge==='inherit'&&(r.weight!==undefined||r.geometry!=='pad-position'))fail('FINE_INHERIT_OBJECTIVE_CONFLICT',r.id);
      if(r.merge!=='inherit'&&r.weight===undefined)fail('FINE_RELATION_WEIGHT_REQUIRED',r.id);
      const binding=base.implements.find(i=>i.type==='pin-distance-objective'),link=model.links.find(l=>l.id===binding.objectiveId);
      if(!link||!link.left.length||!link.right.length)fail('FINE_BASE_ENDPOINT_MISSING',r.id);
      const from=link.a===binding.from.ref?link.left:link.right,to=link.a===binding.from.ref?link.right:link.left;
      for(const [side,pads] of [['from',from],['to',to]]){
        const logical=binding[side],supplied=r[side];
        if(supplied!==undefined){
          fields(supplied,['ref','pin','padId'],'FINE_INVALID_ENDPOINT');
          const sameLogical=supplied.padId===undefined&&supplied.ref===logical.ref&&String(supplied.pin)===logical.pin;
          if(!sameLogical&&(pads.length!==1||pad(supplied).id!==pads[0].id))fail('FINE_BASE_ENDPOINT_CONFLICT',r.id+'.'+side);
        }
        const actual=pads.map(p=>({ref:p.owner??p.number,pin:String(p.number),padId:p.id}));
        r[side]=actual.length===1?actual[0]:{...logical,pads:actual};
      }
      if(r.net!==undefined&&r.net!==binding.net)fail('FINE_BASE_ENDPOINT_CONFLICT',r.id+'.net');r.net=binding.net;
      const sameSet=(a,b)=>a.length===b.length&&a.every(p=>b.some(q=>p.id===q.id));
      const same=(left,right,a,b)=>sameSet(left,a)&&sameSet(right,b);
      const sourceLimitIds=model.limits.flatMap((l,index)=>same(l.left,l.right,from,to)||same(l.left,l.right,to,from)?[l.id??'source-limit:'+index+':'+l.a+'/'+l.b]:[]);
      composition={mode:r.merge,relationId:base.id,source:base.source,requirementId:base.requirementId,objectiveId:link.id,sourceLimitIds,endpointAggregation:'minimum-pad-pair-distance',physicalEndpointPolicy:'retain all mapped pads; placement distance is not all-pad connectivity acceptance'};
      r.source??=base.source;
    }else if(r.merge!==undefined){
      if(r.merge!=='append-objective')fail('FINE_BASE_RELATION_REQUIRED',r.id);
      composition={mode:'explicit-addition'};
    }
    if(r.geometry!==undefined&&!['bbox-center','pad-position'].includes(r.geometry))fail('FINE_INVALID_RELATION_GEOMETRY',r.id);
    if(typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.basis!=='string'||!r.basis.trim())fail('FINE_RELATION_ID_OR_BASIS');ids.add(r.id);
    const left=r.relationId!==undefined?(r.from.pads??[r.from]).map(pad):[pad(r.from)],right=r.relationId!==undefined?(r.to.pads??[r.to]).map(pad):[pad(r.to)],net=left[0].net;
    if([...left,...right].some(p=>p.net!==net)||(r.net!==undefined&&net!==r.net))fail('FINE_RELATION_NET_MISMATCH',r.id);
    if(![...left,...right].some(p=>moving.has(p.owner)))fail('FINE_RELATION_OUTSIDE_MOVABLE',r.id);
    if(r.weight!==undefined&&(!Number.isFinite(r.weight)||r.weight<0))fail('FINE_INVALID_WEIGHT',r.id);
    if(r.maxDistanceMil!==undefined&&(!Number.isFinite(r.maxDistanceMil)||r.maxDistanceMil<0))fail('FINE_INVALID_DISTANCE_CAP',r.id);
    if(r.nonRegression!==undefined){fields(r.nonRegression,['toleranceMil'],'FINE_INVALID_NON_REGRESSION');if(!Number.isFinite(r.nonRegression.toleranceMil)||r.nonRegression.toleranceMil<0)fail('FINE_INVALID_NON_REGRESSION',r.id);}
    if(r.critical!==undefined&&typeof r.critical!=='boolean')fail('FINE_INVALID_CRITICAL',r.id);
    const normalized=(spec,pads)=>pads.length===1?{ref:pads[0].owner??pads[0].number,pin:String(pads[0].number),padId:pads[0].id}:{ref:spec.ref,pin:spec.pin,pads:pads.map(p=>({ref:p.owner??p.number,pin:String(p.number),padId:p.id}))};
    return {...r,...(composition?{composition}:{}),net,from:normalized(r.from,left),to:normalized(r.to,right),weight:r.weight??0};
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
  const frozenRefs=[...model.components.keys()].filter(r=>!moving.has(r));
  const lockSources=Object.fromEntries(frozenRefs.map(ref=>[ref,[...(scoped.lockProvenance.get(ref)??[]),...(fixed.includes(ref)?[]:['fine.scope.context'])]]));
  const actualNets=new Map();for(const p of model.pads){if(!actualNets.has(p.net))actualNets.set(p.net,[]);actualNets.get(p.net).push(p);}
  const crossingNets=[...actualNets].filter(([,pads])=>pads.some(p=>moving.has(p.owner))&&pads.some(p=>!moving.has(p.owner))).map(([net,pads])=>({net,endpoints:pads.map(p=>({ref:p.owner??null,pin:String(p.number),padId:p.id,standalone:!p.owner,movable:moving.has(p.owner),x:p.x,y:p.y}))}));
  const selection={primarySource:input.movableRefs===undefined?'contract.blocks/'+block.id:'request.movableRefs',neighborBlockIds:[...allowedNeighborBlockIds],explicitNeighborRefs:explicitNeighbors,excluded,relations:{mode:relationSelection,derivedIds:derived.map(r=>r.relationId),explicitOverrideIds:[...overrides]}};
  return {model:scoped,request:{schemaVersion:1,blockId:input.blockId??null,movableRefs:primary,allowedNeighborRefs:neighbors,allMovableRefs:movableRefs,fixedRefs:fixed,releaseFixedRefs,region:{...input.region,boundsMil:{...bounds}},labels:{...labels,additionalOwnerRefs},baselinePolicy,reservedRegions,relations,routing,objective},selection,moving,labelMoving,frozenRefs,lockSources,crossingNets,inputHash:digest(input)};
}
