import { compileCpSatProblem } from '../pcb-layout-cpsat-model.mjs';
import { inspectCandidate } from '../pcb-layout-solver-core.mjs';
import { transformPoint } from '../pcb-layout-geometry.mjs';
import { scopeLayoutModel } from '../pcb-layout-scope.mjs';
import { fineLabelRules } from './label-geometry.mjs';
import { fail, issueKey, issueRefs } from './common.mjs';
import { classifyFineIssues } from './issue-policy.mjs';

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
  const baselinePolicy=request.baselinePolicy??'require-clean';
  if(baselinePolicy==='require-clean'&&baseline.validation.issues.length)fail('FINE_BASELINE_NOT_CLEAN');
  // Active constraints still execute. Only proven fixed dependencies are
  // partitioned here; the audit remeasures any old issues left in a candidate.
  const problem=compileCpSatProblem(solverModel,settings,{movableRefs:request.allMovableRefs,includeLabels:!separate});
  // Frozen standalone pads never become implicit movable neighbors.
  for(const entity of problem.entities.filter(e=>e.kind==='testPad'))entity.fixed=true;
  const fixed=ref=>problem.entities.some(e=>e.ref===ref&&e.fixed);
  const source=bodyBaseline,frame={components:source.plan.components,labels:source.plan.labels,pads:source.metrics.geometry.pads,boardBounds:source.plan.boardBounds,zones:source.validation.spatial.zones,rules:{assembly:solverModel.assemblyPolicy,spacing:solverModel.spacingPolicy,spatial:solverModel.spatialRules,limits:solverModel.limits,edges:solverModel.edgeRules,blocks:solverModel.blockRules}};
  const proof=classifyFineIssues({issues:source.validation.issues,baselineIssues:source.validation.issues,before:frame,after:frame,labelMode:request.labels.mode,baselinePolicy});
  const retained=new Set(proof.retainedOutsideIssues.map(issueKey)),constantConstraints=[];
  const mayOmit=(kind,id,dependencies,relevant)=>{
    if(!dependencies.length||!dependencies.every(fixed))return false;
    const failures=source.validation.issues.filter(relevant);
    if(failures.length&&(baselinePolicy!=='retain-outside-issues'||failures.some(i=>!retained.has(issueKey(i)))))return false;
    constantConstraints.push({kind,id,dependencies,issues:failures,proof:failures.length?'unchanged-fixed-dependencies':'satisfied-fixed-dependencies'});return true;
  };
  problem.pairs=problem.pairs.filter(p=>!mayOmit('pair',p.a+'/'+p.b,[p.a,p.b],i=>issueRefs(i).includes(p.a)&&issueRefs(i).includes(p.b)));
  problem.spacing=problem.spacing.filter(p=>moving.has(p.a)||moving.has(p.b));
  problem.blocks=problem.blocks.filter(r=>!mayOmit('block',r.blockId+':'+r.ref,[r.ref,...r.anchors],i=>i.code==='BLOCK_DISTANCE_EXCEEDED'&&i.ref===r.ref&&i.blockId===r.blockId));
  problem.relations=problem.relations.filter(r=>{
    const kinds=r.metric==='bundle-gap'?['bundle','bundle']:r.metric==='geometry-gap'?[r.geometryA,r.geometryB]:[];
    if([r.a,...r.anchors].some((ref,index)=>scope.labelMoving.has(ref)&&['bundle','placement','silkscreen'].includes(kinds[index])))return true;
    return !mayOmit('spatial-relation',r.id,[r.a,...r.anchors],i=>i.id===r.id);
  });
  problem.zones=problem.zones.flatMap(z=>{
    const targets=problem.entities.map(e=>e.ref).filter(ref=>!z.excludeRefs.includes(ref)&&(z.targetRefs===undefined||z.targetRefs.includes(ref)));
    const targetRefs=targets.filter(ref=>['silkscreen','placement','bundle'].includes(z.geometry)&&scope.labelMoving.has(ref)||!mayOmit('keepout',z.id+':'+ref,[ref,...(z.owner?[z.owner]:[])],i=>i.id===z.id&&(i.ref===ref||i.refs?.includes(ref)||i.code==='GEOMETRY_MODEL_UNAVAILABLE')));
    return targetRefs.length?[{...z,targetRefs}]:[];
  });
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
    // Preserve geometry used by active-owner keepouts and cross-boundary rules.
    // Only a proven constant board/edge failure may lose that specific constraint.
    const outside=source.validation.issues.filter(i=>i.code==='BOARD_BOUNDARY_VIOLATION'&&i.ref===entity.ref);
    const omitBoard=outside.length&&mayOmit('board',entity.ref,[entity.ref],i=>outside.includes(i));
    const omitEdge=mayOmit('edge',entity.ref,[entity.ref],i=>i.code==='EDGE_CONSTRAINT_UNSATISFIED'&&i.ref===entity.ref);
    for(const v of entity.variants){
      if(omitEdge)delete v.edge;
      if(omitBoard){const x=(model.config.hard.boardBounds.minX+model.config.hard.boardBounds.maxX)/2-entity.base.x,y=(model.config.hard.boardBounds.minY+model.config.hard.boardBounds.maxY)/2-entity.base.y;v.boardBox={minX:x,maxX:x,minY:y,maxY:y};}
      const local=b=>({minX:b.minX-entity.base.x,maxX:b.maxX-entity.base.x,minY:b.minY-entity.base.y,maxY:b.maxY-entity.base.y});
      v.bundle=local(bundle);v.views.bundle=[v.bundle];v.views.placement=[v.bundle];
    }
  }
  if(separate){const glyphRules=fineLabelRules(model,request.labels);for(const label of baseline.plan.labels.filter(l=>!scope.labelMoving.has(l.owner))){const b=label.bbox,required=glyphRules.clearancesByOwner[label.owner],expand=g=>({minX:b.minX-g,maxX:b.maxX+g,minY:b.minY-g,maxY:b.maxY+g});
    if(required.body===required.pad)problem.zones.push({id:'fine-context-label:'+label.id,mode:'keepout',geometry:'physical',box:expand(required.body),excludeRefs:[],targetRefs:request.allMovableRefs});
    else{problem.zones.push({id:'fine-context-label:'+label.id,mode:'keepout',geometry:'body',box:expand(required.body),excludeRefs:[],targetRefs:request.allMovableRefs});const padRefs=request.allMovableRefs.filter(ref=>model.pads.some(p=>p.owner===ref));if(padRefs.length)problem.zones.push({id:'fine-context-label:'+label.id+':pads',mode:'keepout',geometry:'pads',box:expand(required.pad),excludeRefs:[],targetRefs:padRefs});}
  }}
  const constants=[];
  problem.limits=problem.limits.filter(l=>{
    if([...l.left,...l.right].some(e=>moving.has(e.ref)))return true;
    const xy=p=>{const e=problem.entities.find(e=>e.ref===p.ref),v=e.variants[0],q=(p.geometry==='bbox-center'?v.padCenters:v.pads)[p.id];return {x:e.base.x+q.x,y:e.base.y+q.y};};
    const distanceMil=Math.min(...l.left.flatMap(a=>l.right.map(b=>{const from=xy(a),to=xy(b);return Math.abs(from.x-to.x)+Math.abs(from.y-to.y);}))),passed=distanceMil<=l.maxMil+1e-4;
    constants.push({id:l.id,distanceMil,maxMil:l.maxMil,passed,scope:'frozen context'});
    if(!passed&&(!source.validation.issues.some(i=>i.id===l.id)||!mayOmit('limit',l.id,[...l.left,...l.right].map(e=>e.ref),i=>i.id===l.id)))return true;
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
  problem.fineScope={region:request.region,allMovableRefs:request.allMovableRefs,contextRefs:scope.frozenRefs,lockSources:scope.lockSources,crossingNets:scope.crossingNets,baselinePolicy,selection:scope.selection,baselineIssues:baseline.validation.issues,constantConstraints};
  return {problem,solverModel,baseline,bodyBaseline,baselineRelations,effectiveRelations,objectiveComposition,constantLimits:constants,constantConstraints,baselineIssueKeys:new Set(baseline.validation.issues.map(issueKey))};
}
