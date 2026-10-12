import { compileCpSatProblem } from '../pcb-layout-cpsat-model.mjs';
import { inspectCandidate } from '../pcb-layout-solver-core.mjs';
import { transformPoint } from '../pcb-layout-geometry.mjs';
import { scopeLayoutModel } from '../pcb-layout-scope.mjs';
import { fineLabelRules } from './label-geometry.mjs';
import { fail, issueKey, issueRefs } from './common.mjs';

export const relationEndpoints=(relation,side)=>relation[side].pads??[relation[side]];
export function relationMeasurements(model, poses, relation) {
  const positions=new Map(poses.map(c=>[c.ref,c]));
  const xy=e=>{const p=model.pads.find(p=>p.id===e.padId),q=relation.geometry==='pad-position'?{x:p.x,y:p.y}:{x:(p.bbox.minX+p.bbox.maxX)/2,y:(p.bbox.minY+p.bbox.maxY)/2};return p.owner?transformPoint(q,model.components.get(p.owner),positions.get(p.owner)):q;};
  const pairs=relationEndpoints(relation,'from').flatMap(from=>relationEndpoints(relation,'to').map(to=>{
    const a=xy(from),b=xy(to);return {fromPadId:from.padId,toPadId:to.padId,distanceMil:Math.abs(a.x-b.x)+Math.abs(a.y-b.y)};
  }));
  return {aggregation:'minimum-pad-pair-distance',distanceMil:Math.min(...pairs.map(p=>p.distanceMil)),maximumPairMil:Math.max(...pairs.map(p=>p.distanceMil)),pairs,connectivity:'not-evaluated; every mapped pad remains in the full native network'};
}
export const relationDistance=(model,poses,relation)=>relationMeasurements(model,poses,relation).distanceMil;
export function compileFineProblem(scope, settings={}) {
  const {model,request,moving}=scope,baseline=inspectCandidate(model),separate=request.labels.mode==='separate',solverModel=separate?scopeLayoutModel(model,{includeLabels:false}):model,bodyBaseline=separate?inspectCandidate(solverModel):baseline;
  const outsideIssue=i=>{const refs=issueRefs(i);return refs.length&&refs.every(r=>!moving.has(r));};
  if(request.baselinePolicy==='require-clean'&&baseline.validation.issues.length)fail('FINE_BASELINE_NOT_CLEAN');
  // In incremental mode the moving scope may repair its current defects;
  // only unchanged OUTSIDE issues may later be retained by the audit.
  const problem=compileCpSatProblem(solverModel,settings,{movableRefs:request.allMovableRefs,includeLabels:!separate});
  // Frozen standalone pads never become implicit movable neighbors.
  for(const entity of problem.entities.filter(e=>e.kind==='testPad'))entity.fixed=true;
  problem.pairs=problem.pairs.filter(p=>moving.has(p.a)||moving.has(p.b));
  problem.spacing=problem.spacing.filter(p=>moving.has(p.a)||moving.has(p.b));
  for(const entity of problem.entities.filter(e=>e.fixed)){
    const bundle=bodyBaseline.plan.bundles.find(b=>b.ref===entity.ref)?.bbox;
    if(!bundle)fail('FINE_CONTEXT_BUNDLE_MISSING',entity.ref);
    const variant=entity.variants[0],groups=new Map();
    for(const ref of request.allMovableRefs){const gap=model.pairClearanceMap.get(JSON.stringify([ref,entity.ref].sort()))??model.mechanical.clearanceMil;if(!groups.has(gap))groups.set(gap,[]);groups.get(gap).push(ref);}
    for(const [gap,targetRefs] of groups){
      const expand=box=>({minX:box.minX-gap,maxX:box.maxX+gap,minY:box.minY-gap,maxY:box.maxY+gap});
      problem.zones.push({id:'fine-context-placement:'+entity.ref+(groups.size>1?':'+gap:''),mode:'keepout',geometry:'placement',box:expand(bundle),excludeRefs:[],targetRefs});
      const p=variant.physical,physical={minX:p.minX+entity.base.x,maxX:p.maxX+entity.base.x,minY:p.minY+entity.base.y,maxY:p.maxY+entity.base.y};
      problem.zones.push({id:'fine-context-physical:'+entity.ref+':'+gap,mode:'keepout',geometry:'physical',box:expand(physical),excludeRefs:[],targetRefs});
    }
    const assembly=baseline.metrics.geometry.assembly.filter(v=>v.ref===entity.ref);
    assembly.forEach((view,index)=>problem.zones.push({id:'fine-context-assembly:'+entity.ref+':'+index,mode:'keepout',geometry:'assembly',box:view.bbox,excludeRefs:[],targetRefs:request.allMovableRefs.filter(ref=>problem.entities.find(e=>e.ref===ref).variants.every(v=>v.views.assembly.length))}));
    // Keep real fixed pad coordinates for ALL source/cross-boundary relations.
    // Their collision footprints are constant zones, so frozen baseline defects
    // are not re-solved. Decode restores their real bodies and labels below.
    for(const v of entity.variants){const zero={minX:0,maxX:0,minY:0,maxY:0};delete v.edge;for(const k of ['body','bundle','physical','courtyard','boardBox'])v[k]={...zero};for(const k of ['body','bundle','physical','placement','assembly','silkscreen'])v.views[k]=k==='silkscreen'?[]:[{...zero}];}
  }
  if(separate){const glyphRules=fineLabelRules(model,request.labels);for(const label of baseline.plan.labels.filter(l=>!scope.labelMoving.has(l.owner))){const b=label.bbox,g=glyphRules.gapByOwner[label.owner];problem.zones.push({id:'fine-context-label:'+label.id,mode:'keepout',geometry:'physical',box:{minX:b.minX-g,maxX:b.maxX+g,minY:b.minY-g,maxY:b.maxY+g},excludeRefs:[],targetRefs:request.allMovableRefs});}}
  const constants=[];
  problem.limits=problem.limits.filter(l=>{
    if([...l.left,...l.right].some(e=>moving.has(e.ref)))return true;
    const xy=p=>{const e=problem.entities.find(e=>e.ref===p.ref),v=e.variants[0],q=(p.geometry==='bbox-center'?v.padCenters:v.pads)[p.id];return {x:e.base.x+q.x,y:e.base.y+q.y};};
    const distanceMil=Math.min(...l.left.flatMap(a=>l.right.map(b=>{const from=xy(a),to=xy(b);return Math.abs(from.x-to.x)+Math.abs(from.y-to.y);}))),passed=distanceMil<=l.maxMil+1e-4;
    constants.push({id:l.id,distanceMil,maxMil:l.maxMil,passed,scope:'frozen context'});
    if(!passed&&request.baselinePolicy!=='retain-outside-issues')fail('FINE_FROZEN_LIMIT_FAILED',l.id);
    return false;
  });
  const bounds=request.region.boundsMil;
  problem.bodyCoordinateBounds=request.allMovableRefs.flatMap(ref=>['minX','maxX','minY','maxY'].map(key=>({ref,key,minimumMil:key.endsWith('X')?bounds.minX:bounds.minY,maximumMil:key.endsWith('X')?bounds.maxX:bounds.maxY})));
  const board=model.config.hard.boardBounds;
  const margins=[{minX:board.minX,maxX:bounds.minX,minY:board.minY,maxY:board.maxY},{minX:bounds.maxX,maxX:board.maxX,minY:board.minY,maxY:board.maxY},{minX:board.minX,maxX:board.maxX,minY:board.minY,maxY:bounds.minY},{minX:board.minX,maxX:board.maxX,minY:bounds.maxY,maxY:board.maxY}];
  margins.filter(b=>b.minX<b.maxX&&b.minY<b.maxY).forEach((box,index)=>problem.zones.push({id:'fine-region-physical:'+index,mode:'keepout',geometry:'physical',box,excludeRefs:[],targetRefs:request.allMovableRefs}));
  for(const r of request.reservedRegions){if(r.geometry==='assembly'&&request.allMovableRefs.some(ref=>problem.entities.find(e=>e.ref===ref).variants.some(v=>!v.views.assembly.length)))fail('FINE_ASSEMBLY_VIEW_UNAVAILABLE',r.id);problem.zones.push({id:'fine-reservation:'+r.id,mode:'keepout',geometry:r.geometry==='placement'?'bundle':r.geometry,box:r.boundsMil,excludeRefs:[],targetRefs:request.allMovableRefs});}
  const sourceLinks=new Map(problem.links.map(l=>[l.id,l]));
  if(!request.objective.retainSource){problem.links=[];problem.nets=[];problem.spacing=[];}
  const endpoint=(e,geometry)=>({ref:e.ref,id:e.padId,...(geometry==='pad-position'?{}:{geometry:'bbox-center'})});
  const baselineRelations=request.relations.map(r=>({id:r.id,distanceMil:relationDistance(model,baseline.plan.components,r)}));
  const effectiveRelations=request.relations.map(r=>{
    const source=r.composition?.objectiveId?sourceLinks.get(r.composition.objectiveId):null;
    if(r.composition?.objectiveId&&!source)fail('FINE_BASE_OBJECTIVE_MISSING',r.id);
    const weight=r.merge==='inherit'?source.weight:r.weight;
    const composition={...(r.composition??{mode:'legacy-addition'}),sourceWeight:source?.weight??null,sourceGeometry:source?'pad-position':null,effectiveGeometry:r.geometry??'bbox-center',effectiveWeight:weight};
    return {...r,weight,composition};
  });
  for(const r of effectiveRelations){
    const left=relationEndpoints(r,'from').map(e=>endpoint(e,r.geometry)),right=relationEndpoints(r,'to').map(e=>endpoint(e,r.geometry));
    if(r.merge==='replace-objective')problem.links=problem.links.filter(l=>l.id!==r.composition.objectiveId);
    if(r.merge!=='inherit'&&r.weight>0)problem.links.push({id:'fine-soft:'+r.id,left,right,weight:r.weight});
    const before=baselineRelations.find(b=>b.id===r.id).distanceMil;
    if(r.maxDistanceMil!==undefined)problem.limits.push({id:'fine-hard:'+r.id,left,right,maxMil:r.maxDistanceMil});
    if(r.nonRegression)problem.limits.push({id:'fine-comparison:'+r.id,left,right,maxMil:before+r.nonRegression.toleranceMil});
  }
  const objectiveComposition={retainSource:request.objective.retainSource,relations:effectiveRelations.map(r=>({id:r.id,...r.composition})),effectiveLinks:problem.links.map(l=>({id:l.id,weight:l.weight,geometry:l.left[0]?.geometry??'pad-position'}))};
  problem.objectiveComposition=objectiveComposition;
  problem.fineScope={region:request.region,allMovableRefs:request.allMovableRefs,contextRefs:scope.frozenRefs,lockSources:scope.lockSources,crossingNets:scope.crossingNets,baselinePolicy:request.baselinePolicy,selection:scope.selection};
  return {problem,solverModel,baseline,bodyBaseline,baselineRelations,effectiveRelations,objectiveComposition,constantLimits:constants,baselineIssueKeys:new Set(baseline.validation.issues.map(issueKey))};
}
