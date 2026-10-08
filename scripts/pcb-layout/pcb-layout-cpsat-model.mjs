// Compile existing engineering semantics; CP-SAT never reads provider objects.
import { translatedSnapshot, validatePlan, measure, score, scoreBreakdown } from './pcb-layout-solver-core.mjs';
import { labelVariants } from './pcb-layout-mechanical-plan.mjs';
import { buildGeometryViews } from './pcb-layout-geometry-views.mjs';
import { transformBox, angle } from './pcb-layout-geometry.mjs';
import { scoreReferenceMil } from './pcb-layout-reference-scale.mjs';
import { resolveAssemblyPairSpacing } from './pcb-layout-spacing-evaluation.mjs';
import { spacingNeighbors } from './pcb-layout-uniformity.mjs';

const union = bs => ({ minX: Math.min(...bs.map(b=>b.minX)), minY: Math.min(...bs.map(b=>b.minY)), maxX: Math.max(...bs.map(b=>b.maxX)), maxY: Math.max(...bs.map(b=>b.maxY)) });
const shift = (b,x,y) => ({minX:b.minX+x,minY:b.minY+y,maxX:b.maxX+x,maxY:b.maxY+y});
const zero = {x:0,y:0,rotation:0};
const pairKey = (a,b) => JSON.stringify([a,b].sort());

export function cpSatSettings(input = {}) {
  const defaults = { resolutionMil: .1, timeLimitSeconds: 30, seed: 92701, workers: 4, displacementWeight: 0 };
  if(input&&typeof input==='object'&&['refineRounds','neighborhoodSize','refineRadiusMil'].some(key=>Object.hasOwn(input,key)))throw Error('CPSAT_UNSUPPORTED_REFINEMENT_SETTINGS: refinement is not executed by this backend');
  if(!input || Array.isArray(input) || typeof input!=='object' || Object.keys(input).some(k=>!Object.hasOwn(defaults,k))) throw Error('INVALID_CPSAT_SETTINGS');
  const s={...defaults,...input};
  for(const [key,value] of Object.entries(s)) if(!Number.isFinite(value)||value<0) throw Error('INVALID_CPSAT_SETTING '+key);
  if(s.resolutionMil<1e-6||s.resolutionMil>5||s.timeLimitSeconds<=0||s.timeLimitSeconds>86400)throw Error('INVALID_CPSAT_BUDGET_OR_RESOLUTION');
  for(const key of ['seed','workers'])if(!Number.isInteger(s[key]))throw Error('INVALID_CPSAT_SETTING '+key);
  if(s.workers<1||s.workers>64||s.seed>2147483647)throw Error('INVALID_CPSAT_SETTING_RANGE');
  return s;
}

export function compileCpSatProblem(model, settings = {}, { weights=model.config.comparisonWeights, previousPlan, initialProposal, movableRefs, radiusMil, placementMode='board', includeLabels=true, computationalCoordinateMil } = {}) {
  if(!['board','open'].includes(placementMode)||typeof includeLabels!=='boolean')throw Error('INVALID_CPSAT_PLACEMENT_MODE');
  const options=cpSatSettings(settings), open=placementMode==='open', board=open?{}:model.config.hard.boardBounds;
  if(open&&(model.modelScope?.placementMode!=='open'||model.config.hard.boardBounds||model.edgeRules.length))throw Error('CPSAT_OPEN_REQUIRES_SCOPED_MODEL');
  if(open&&(!Number.isFinite(computationalCoordinateMil)||computationalCoordinateMil<=0))throw Error('INVALID_OPEN_COORDINATE_DOMAIN');
  if(!open&&!board)throw Error('CPSAT_BOARD_REQUIRED: supply a verified rectangular board, not an inferred component envelope');
  if(!includeLabels&&(model.snapshot.items.length||model.geometryModel.labels.length))throw Error('CPSAT_LABEL_SCOPE_MISMATCH');
  if(initialProposal&&previousPlan)throw Error('CPSAT_CONFLICTING_START_SOURCES');
  const fresh=initialProposal?.metadata?.mode==='fresh',current=previousPlan??null;
  if(initialProposal){
    if(!fresh||!Array.isArray(initialProposal.components)||!Array.isArray(initialProposal.testPads))throw Error('CPSAT_INVALID_INITIAL_PROPOSAL');
    const components=initialProposal.components,pads=initialProposal.testPads,originalPads=model.pads.filter(p=>!p.owner);
    if(components.length!==model.components.size||new Set(components.map(c=>c.ref)).size!==components.length||pads.length!==originalPads.length||new Set(pads.map(p=>p.id)).size!==pads.length)throw Error('CPSAT_INITIAL_PROPOSAL_OBJECTS');
    for(const c of components){
      const fixed=model.fixed.get(c.ref);
      if(!model.components.has(c.ref)||!['x','y','rotation'].every(k=>Number.isFinite(c[k]))||!model.allowedRotations.get(c.ref).includes(angle(c.rotation)))throw Error('CPSAT_INITIAL_PROPOSAL_POSE '+c.ref);
      if(fixed&&['x','y','rotation'].some(k=>c[k]!==fixed[k]))throw Error('CPSAT_INITIAL_PROPOSAL_FIXED '+c.ref);
    }
    for(const p of pads){
      const old=originalPads.find(o=>o.id===p.id);
      if(!old||p.net!==old.net||p.number!==old.number||!Number.isFinite(p.x)||!Number.isFinite(p.y)||(old.locked&&(p.x!==old.x||p.y!==old.y)))throw Error('CPSAT_INITIAL_PROPOSAL_TESTPAD '+p.id);
    }
  }
  const referenceComponents=initialProposal?.components??current?.components??model.snapshot.components;
  const referencePads=initialProposal?.testPads??current?.testPads;
  const references=new Map(referenceComponents.map(c=>[c.ref,c]));
  const byRotation=new Map();
  const rotations=[...new Set([...model.allowedRotations.values()].flat().map(angle))];
  for(const rotation of rotations){
    const snapshot=translatedSnapshot(model,model.snapshot.components.map(c=>({ref:c.ref,x:0,y:0,rotation})),current);
    const views=buildGeometryViews(model.geometryModel,snapshot.components,undefined,current?.testPads);
    byRotation.set(rotation,{snapshot,views});
  }
  const selectedRefs=movableRefs?new Set(movableRefs):null;
  const entities=model.snapshot.components.map(original=>{
    const ref=original.ref, desired=references.get(ref), fixed=model.fixed.has(ref)||(selectedRefs&&!selectedRefs.has(ref));
    const allowed=fixed?[desired.rotation]:fresh?[...model.allowedRotations.get(ref)].sort((a,b)=>a-b):model.allowedRotations.get(ref);
    const variants=[];
    for(const rotation of allowed){
      const {snapshot,views}=byRotation.get(angle(rotation));
      const component=snapshot.components.find(c=>c.ref===ref), pads=snapshot.pads.filter(p=>p.owner===ref);
      const physical=union([component.bbox,...pads.map(p=>p.bbox)]);
      const courtyard=views.assemblyPolicy?.courtyards.find(c=>c.ref===ref)?.bbox??physical;
      const edge=model.edgeDomains.get(ref);
      const states=edge?edge.states.filter(s=>angle(s.rotation)===angle(rotation)):[null];
      let templates=includeLabels?labelVariants(snapshot,component,{...model.mechanical,initializeLabels:fresh}):[{side:null,body:component.bbox,labels:[],bbox:component.bbox}];
      if(selectedRefs&&!selectedRefs.has(ref))templates=templates.slice(0,1);
      for(const label of templates)for(const state of states){
        const shapeViews={body:[component.bbox],footprint:[component.bbox],bundle:[label.bbox],placement:[label.bbox],pads:pads.map(p=>p.bbox),silkscreen:label.labels.map(l=>l.bbox),physical:[physical]};
        for(const kind of ['assembly','operation'])shapeViews[kind]=views[kind].filter(v=>v.ref===ref).map(v=>v.bbox);
        const zones={};
        for(const z of model.spatialRules.zones.filter(z=>z.owner===ref)){
          const envelope=z.envelopeId?[...views.assembly,...views.operation].find(v=>v.id===z.envelopeId)?.bbox:transformBox(z.box,zero,{x:0,y:0,rotation});
          if(!envelope)throw Error('CPSAT_ZONE_GEOMETRY_MISSING '+z.id);
          zones[z.id]=envelope;
        }
        const originOffset={x:0,y:0};
        if(state&&!fixed){
          const axis=state.normalAxis,target=board[state.normalKey]-state.bodyOffset[state.normalKey];
          originOffset[axis]=target-desired[axis]-Math.round((target-desired[axis])/options.resolutionMil)*options.resolutionMil;
        }
        variants.push({rotation,side:label.side,originOffset,body:label.body,labels:label.labels,bundle:label.bbox,physical,courtyard,boardBox:union([label.bbox,physical]),views:shapeViews,zones,
          pads:Object.fromEntries(pads.map(p=>[p.id,{x:p.x,y:p.y}])),
          padCenters:Object.fromEntries(pads.map(p=>[p.id,{x:(p.bbox.minX+p.bbox.maxX)/2,y:(p.bbox.minY+p.bbox.maxY)/2}])),
          edge:state?{key:state.normalKey,sign:state.normalSign,maxInsetMil:edge.maxInsetMil,offset:state.bodyOffset[state.normalKey]}:null});
      }
    }
    if(!variants.length)throw Error('CPSAT_NO_LEGAL_VARIANTS '+ref);
    return {ref,id:original.id,kind:'component',base:{x:desired.x,y:desired.y},preferredVariant:Math.max(0,variants.findIndex(v=>angle(v.rotation)===angle(desired.rotation))),fixed:Boolean(fixed),radiusMil:!fixed?radiusMil:undefined,variants};
  });
  for(const p of model.pads.filter(p=>!p.owner)){
    const desired=referencePads?.find(t=>t.id===p.id)??p, local=shift(p.bbox,-p.x,-p.y);
    entities.push({ref:p.number,id:p.id,kind:'testPad',base:{x:desired.x,y:desired.y},fixed:Boolean(p.locked||(selectedRefs&&!selectedRefs.has(p.number))),radiusMil,
      variants:[{rotation:0,side:null,labels:[],body:local,bundle:local,physical:local,courtyard:local,boardBox:local,pads:{[p.id]:{x:0,y:0}},padCenters:{[p.id]:{x:(local.minX+local.maxX)/2,y:(local.minY+local.maxY)/2}},views:{body:[local],bundle:[local],placement:[local],pads:[local],physical:[local],assembly:model.assemblyPolicy?[local]:[],footprint:[],silkscreen:[],operation:[]},zones:{}}]});
  }
  const padRef=new Map(model.pads.map(p=>[p.id,p.owner??p.number]));
  const pin=p=>({ref:padRef.get(p.id),id:p.id});
  const divisor=Object.keys(model.config.comparisonWeights).filter(k=>k!=='uniformity').reduce((n,k)=>n+(weights[k]??0),0);
  if(!(divisor>0))throw Error('NO_OBJECTIVE_WEIGHTS');
  const links=model.links.map(l=>({id:l.id,left:l.left.map(pin),right:l.right.map(pin),weight:(weights[l.group]??0)/divisor/scoreReferenceMil(model,l.group)}));
  const limits=model.limits.map(l=>({id:l.id??l.a+'/'+l.b,left:l.left.map(pin),right:l.right.map(pin),maxMil:l.maxMil}));
  for(const r of model.couplingModel.relations)if(r.maxDistanceMil!==undefined)limits.push({id:r.id,left:r.from.padIds.map(id=>({ref:padRef.get(id),id,geometry:'bbox-center'})),right:r.to.padIds.map(id=>({ref:padRef.get(id),id,geometry:'bbox-center'})),maxMil:r.maxDistanceMil});
  const nets=model.connectivity.map(n=>({name:n.name,pads:n.pads.map(pin),weight:(weights.connectivity??0)/divisor/scoreReferenceMil(model,'connectivity')}));
  const physicalMinima=new Map((model.assemblyPolicy?.pairClearancesMil??[]).map(r=>[pairKey(r.a,r.b),r.hardMinMil]));
  const pairs=[];
  for(let i=0;i<entities.length;i++)for(let j=i+1;j<entities.length;j++){
    const a=entities[i].ref,b=entities[j].ref;
    pairs.push({a,b,gapMil:model.pairClearanceMap.get(pairKey(a,b))??model.mechanical.clearanceMil,physicalGapMil:Math.max(model.assemblyPolicy?.absoluteFloorMil??0,physicalMinima.get(pairKey(a,b))??0)});
  }
  const spacing=[];
  if(model.spacingPolicy&&(weights.uniformity??0)>0){
    const views=buildGeometryViews(model.geometryModel,referenceComponents,current?.labels,referencePads);
    const physical=new Map(views.physical.map(s=>[s.ref,s.bbox])),courtyards=new Map(views.assemblyPolicy.courtyards.map(s=>[s.ref,s.bbox]));
    const neighbors=spacingNeighbors([...model.components.keys()].map(ref=>({ref,bbox:physical.get(ref)})));
    for(const n of neighbors){
      const p=resolveAssemblyPairSpacing(model.spacingPolicy,n.a,n.b,physical,courtyards);
      spacing.push({a:n.a,b:n.b,minMil:p.neutralMinMil,maxMil:p.neutralMaxMil,weight:weights.uniformity/Math.max(1,neighbors.length)/p.baselineMil});
    }
  }
  const coverage={hard:[...(!open?['board','edge-domain']:[]),'fixed-pose','rotation-domain',...(includeLabels?['native-label-variants']:[]),'bundle-clearance','assembly-directional-clearance','pin-distance','block-anchor-distance','spatial-distance','keepout'],
    objective:{electrical:'existing normalized pin distances and network HPWL',spacing:spacing.length?'frozen neighbor graph with linear band penalty; full score retains dynamic neighbors and squared penalties':'external evaluation only',displacement:'search preference, excluded from final quality score'},
    initialization:{mode:fresh?'fresh':current?'existing-plan':'existing',poseSource:fresh?(initialProposal.metadata.source??'electrical-topology'):'accepted-plan-or-snapshot',sourceLabelPositionsUsed:!fresh},
    observations:['local-group compactness','preferEmpty/preferFilled'],verification:'original validatePlan after exact geometry reconstruction', scope:model.modelScope??{source:'prepared public layout model',sourceHash:model.snapshot.sourceHash,refs:[...model.components.keys()],placementMode,includeLabels}};
  return {schemaVersion:1,kind:'flitrealize-cpsat-problem',sourceHash:model.snapshot.sourceHash,units:'mil',board,settings:options,entities,pairs,assembly:Boolean(model.assemblyPolicy),links,limits,nets,spacing,
    blocks:model.blockRules,relations:model.spatialRules.relations,zones:model.spatialRules.zones.filter(z=>z.mode==='keepout'),coverage,...(open?{openPlacement:true,computationalCoordinateMil}:{} )};
}

export function decodeCpSatCandidate(model, problem, result, {name='cpsat',label='CP-SAT'} = {}) {
  if(result.status!=='FEASIBLE'&&result.status!=='OPTIMAL')throw Error('CPSAT_NO_SOLUTION '+result.status);
  if(result.sourceHash!==model.snapshot.sourceHash||!Array.isArray(result.placements)||result.placements.length!==problem.entities.length||new Set(result.placements.map(p=>p.ref)).size!==problem.entities.length)throw Error('CPSAT_RESULT_IDENTITY');
  const entities=new Map(problem.entities.map(e=>[e.ref,e])),components=[],labels=[],testPads=[],bundles=[];
  for(const p of result.placements){
    const e=entities.get(p.ref);
    if(!e||![p.dx,p.dy,p.variant].every(Number.isSafeInteger)||!e.variants[p.variant]||(e.fixed&&(p.dx||p.dy)))throw Error('CPSAT_RESULT_POSE '+p.ref);
    const v=e.variants[p.variant],x=e.base.x+p.dx*problem.settings.resolutionMil+(v.originOffset?.x??0),y=e.base.y+p.dy*problem.settings.resolutionMil+(v.originOffset?.y??0);
    if(e.radiusMil!==undefined&&(Math.abs(x-e.base.x)>e.radiusMil+1e-8||Math.abs(y-e.base.y)>e.radiusMil+1e-8))throw Error('CPSAT_RESULT_WINDOW '+p.ref);
    bundles.push({ref:e.ref,bbox:shift(v.bundle,x,y)});
    if(e.kind==='testPad'){
      const old=model.pads.find(p=>p.id===e.id);
      testPads.push({id:e.id,number:old.number,net:old.net,x,y,dx:x-old.x,dy:y-old.y,bbox:shift(v.body,x,y)});
    }else{
      const old=model.components.get(e.ref);
      components.push({id:e.id,ref:e.ref,x,y,rotation:v.rotation,dx:x-old.x,dy:y-old.y,deltaRotation:angle(v.rotation-old.rotation),body:shift(v.body,x,y),side:v.side});
      for(const local of v.labels){
        const old=model.snapshot.items.find(t=>t.id===local.id).original,l={...local,x:local.x+x,y:local.y+y,bbox:shift(local.bbox,x,y)};
        l.changed=Math.abs(l.x-old.x)>.001||Math.abs(l.y-old.y)>.001||l.rotation!==old.rotation||l.alignMode!==old.alignMode;labels.push(l);
      }
    }
  }
  const plan={status:'planned',sourceHash:model.snapshot.sourceHash,boardBounds:model.config.hard.boardBounds,clearanceMil:model.mechanical.clearanceMil,components,labels,testPads,bundles,issues:[],
    counts:{components:components.length,labels:labels.length,testPads:testPads.length,moved:components.filter(c=>c.dx||c.dy).length,rotated:components.filter(c=>c.deltaRotation).length,labelsChanged:labels.filter(l=>l.changed).length,testPadsMoved:testPads.filter(p=>p.dx||p.dy).length},maxMoveMil:Math.max(0,...components.map(c=>Math.hypot(c.dx,c.dy)))};
  const validation=validatePlan(model,plan),metrics=validation.valid?measure(model,components,labels,bundles,testPads):null;
  if(metrics)plan.counts.silkRelocated=metrics.silkRelocatedCount;
  return {name,label,plan,validation,metrics,comparisonScore:metrics?score(model,metrics):null,scores:metrics?scoreBreakdown(model,metrics):null,stats:{backend:'cpsat',...result.solver},coverage:problem.coverage};
}
