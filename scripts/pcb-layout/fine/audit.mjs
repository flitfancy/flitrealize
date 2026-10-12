import { decodeCpSatCandidate } from '../pcb-layout-cpsat-model.mjs';
import { validatePlan } from '../pcb-layout-solver-core.mjs';
import { buildGeometryViews } from '../pcb-layout-geometry-views.mjs';
import { transformBox, transformPoint, angle } from '../pcb-layout-geometry.mjs';
import { evaluateSpatial } from '../pcb-layout-spatial.mjs';
import { evaluateBlockCoupling } from '../pcb-layout-block-coupling.mjs';
import { checkEdges } from '../pcb-layout-edge.mjs';
import { checkBlocks } from '../pcb-layout-features.mjs';
import { evaluateSpacingPolicy } from '../pcb-layout-spacing-evaluation.mjs';
import { relationDistance } from './compile.mjs';
import { scopeLayoutModel } from '../pcb-layout-scope.mjs';
import { independentLabelGeometry, fineLabelRules } from './label-geometry.mjs';
import { digest, fail, issueKey, issueRefs, near, samePose, sameBox, union, within } from './common.mjs';

function measureSourceLimits(model,plan,moving=new Set()) {
  const positions=new Map(plan.components.map(c=>[c.ref,c]));
  const point=p=>p.owner?transformPoint({x:p.x,y:p.y},model.components.get(p.owner),positions.get(p.owner)):{x:p.x,y:p.y};
  return model.limits.map((l,index)=>{
    const distanceMil=Math.min(...l.left.flatMap(a=>l.right.map(b=>{a=point(a);b=point(b);return Math.abs(a.x-b.x)+Math.abs(a.y-b.y);}))),refs=[...new Set([...l.left,...l.right].map(p=>p.owner??p.number))];
    return {id:l.id??'source-limit:'+index+':'+l.a+'/'+l.b,refs,distanceMil,maxMil:l.maxMil,active:refs.some(ref=>moving.has(ref)),passed:distanceMil<=l.maxMil+1e-4};
  });
}
function review(scope,plan,bodyOnly=false) {
  const model=scope.model,separate=scope.request.labels.mode==='separate',bodyModel=separate?scopeLayoutModel(model,{includeLabels:false}):model;
  const bodyPlan=separate?{...plan,labels:[],bundles:plan.components.map(c=>({ref:c.ref,bbox:c.body})).concat(plan.testPads.map(p=>({ref:p.number,bbox:p.bbox})))}:plan;
  const validation=validatePlan(bodyModel,bodyPlan),geometry=buildGeometryViews(bodyOnly?bodyModel.geometryModel:model.geometryModel,plan.components,bodyOnly?[]:plan.labels,plan.testPads);
  geometry.physical??=plan.components.map(c=>({ref:c.ref,bbox:union([c.body,...geometry.pads.filter(p=>(p.owner??p.ref)===c.ref).map(p=>p.bbox)]),source:'native-footprint-and-pad-bbox-proxy'}));
  for(const p of plan.testPads)if(!geometry.physical.some(v=>v.ref===p.number))geometry.physical.push({ref:p.number,bbox:p.bbox,source:'native-standalone-pad-bbox'});
  // Public validatePlan short-circuits feature checks after geometry failures.
  // Evaluate them independently, so unchanged outside issues never hide a new
  // boundary, assembly or electrical violation involving the moving block.
  const features=[...checkEdges(model.edgeRules,plan.components,model.config.hard.boardBounds).issues,...checkBlocks(model.blockRules,plan.components).issues,
    ...evaluateSpatial(model.spatialRules,plan.components,plan.bundles,geometry).issues,...evaluateBlockCoupling(model.couplingModel,plan.components,geometry.pads).issues,
    ...(geometry.assemblyPolicy?.issues??[]),...(evaluateSpacingPolicy(model.spacingPolicy,geometry,plan.components.map(c=>c.ref))?.issues??[])];
  const silk=separate&&!bodyOnly?independentLabelGeometry({components:plan.components,pads:geometry.pads,labels:plan.labels,...fineLabelRules(model,scope.request.labels)}):{issues:[]};
  const labelIdentity=[];
  if(!bodyOnly){if(plan.labels.length!==model.snapshot.items.length||new Set(plan.labels.map(l=>l.id)).size!==model.snapshot.items.length)labelIdentity.push({code:'FINE_LABEL_COUNT'});for(const l of plan.labels){const old=model.snapshot.items.find(i=>i.id===l.id);if(!old||['owner','parentId','type','text','fontSize','lineWidth'].some(k=>old[k]!==l[k]))labelIdentity.push({code:'FINE_LABEL_METADATA_CHANGED',owner:l.owner,id:l.id});if(l.bbox&&!within(l.bbox,model.config.hard.boardBounds))labelIdentity.push({code:'FINE_LABEL_BOARD_BOUNDARY',owner:l.owner,id:l.id,bbox:l.bbox});}}
  // Public validation short-circuits these checks after a geometry failure and
  // reports unnamed limits without owners. Independently measure ALL source
  // limits on BOTH poses so a latent, unchanged outside failure cannot become
  // a falsely new local defect merely because an unrelated overlap was repaired.
  const limits=measureSourceLimits(model,plan).filter(l=>!l.passed).map(l=>({code:'PIN_DISTANCE_LIMIT',id:l.id,refs:l.refs,mil:l.distanceMil,maxMil:l.maxMil}));
  const issues=[...new Map([...validation.issues.filter(i=>i.code!=='PIN_DISTANCE_LIMIT'),...features,...limits,...silk.issues,...labelIdentity].map(i=>[issueKey(i),i])).values()];
  return {validation,geometry,issues};
}
export function verifyFineReadback(model,plan,actual) {
  const eq=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.02,box=(a,b)=>a&&b&&['minX','maxX','minY','maxY'].every(k=>eq(a[k],b[k])),rotation=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&eq(angle(a),angle(b));
  if(actual.placements?.length!==plan.components.length||actual.labels?.length!==plan.labels.length||actual.pads?.length!==model.pads.length)fail('FINE_READBACK_INVENTORY');
  for(const c of plan.components){const a=actual.placements.find(a=>a.id===c.id);if(!a||a.ref!==c.ref||!['x','y'].every(k=>eq(a[k],c[k]))||!rotation(a.rotation,c.rotation))fail('FINE_READBACK_COMPONENT',c.ref);}
  for(const l of plan.labels){const a=actual.labels.find(a=>a.id===l.id);if(!a||a.owner!==l.owner||!['x','y'].every(k=>eq(a[k],l[k]))||!rotation(a.rotation,l.rotation)||a.alignMode!==l.alignMode||!box(a.bbox,l.bbox))fail('FINE_READBACK_LABEL',l.id);}
  const geometry=buildGeometryViews(model.geometryModel,plan.components,plan.labels,plan.testPads);
  for(const p of model.pads){const a=actual.pads.find(a=>a.id===p.id),native=model.snapshot.pads.find(q=>q.id===p.id),target=geometry.pads.find(q=>q.id===p.id);if(!a||!native||a.owner!==native.owner||a.parentComponentId!==native.parentComponentId||String(a.number)!==String(p.number)||a.net!==p.net||!box(a.bbox,target.bbox))fail('FINE_READBACK_PAD',p.id);}
  if(digest(actual.outlines)!==digest(model.snapshot.outlines)||digest(actual.routing)!==digest(model.snapshot.routing))fail('FINE_READBACK_SCENE_CHANGED');
  return {verified:true,components:plan.components.length,labels:plan.labels.length,pads:model.pads.length};
}
export function materializeFineCandidate(scope,compilation,result,{labels,bodyOnly=false}={}) {
  const candidate=decodeCpSatCandidate(compilation.solverModel??scope.model,compilation.problem,result,{name:'fine',label:'Fine layout'}),plan=candidate.plan;
  const originals=new Map(compilation.baseline.plan.labels.map(l=>[l.id,l]));
  if(scope.request.labels.mode==='separate')plan.labels=labels??compilation.baseline.plan.labels.map(l=>({...l}));
  plan.labels=plan.labels.map(l=>scope.moving.has(l.owner)?l:{...originals.get(l.id)});
  for(const c of plan.components){const old=scope.model.components.get(c.ref);c.body=transformBox(old.bbox,old,c);c.dx=c.x-old.x;c.dy=c.y-old.y;}
  // Frozen context rectangles were neutralized only for solving. Restore every
  // standalone pad's real footprint before independent acceptance/readback.
  for(const p of plan.testPads){const old=scope.model.pads.find(q=>q.id===p.id);if(!old||!near(p.x,old.x)||!near(p.y,old.y))fail('FINE_STANDALONE_CHANGED',p.id);p.bbox={...old.bbox};p.dx=p.x-old.x;p.dy=p.y-old.y;}
  plan.geometryPolicy={labelMode:scope.request.labels.mode};
  plan.bundles=plan.components.map(c=>({ref:c.ref,bbox:scope.request.labels.mode==='separate'?c.body:union([c.body,...plan.labels.filter(l=>l.owner===c.ref).map(l=>l.bbox)])})).concat(plan.testPads.map(p=>({ref:p.number,bbox:p.bbox})));
  plan.issues=[];plan.sourceBefore=scope.model.snapshot.source;
  const audit=auditFineCandidate(scope,compilation,plan,{bodyOnly});
  return {schemaVersion:1,kind:bodyOnly?'flitrealize.fine-layout.body-candidate':'flitrealize.fine-layout.candidate',plan,audit,candidateHash:digest(plan)};
}
export function auditFineCandidate(scope,compilation,plan,{bodyOnly=false}={}) {
  const {model,request,moving}=scope,actual=review(scope,plan,bodyOnly),before=review(scope,compilation.baseline.plan,bodyOnly),oldKeys=new Set(before.issues.map(issueKey));
  const isOutside=i=>{const refs=issueRefs(i);return refs.length&&refs.every(r=>!moving.has(r));};
  const retainedOutsideIssues=actual.issues.filter(i=>oldKeys.has(issueKey(i))&&isOutside(i)),blockingIssues=actual.issues.filter(i=>!(request.baselinePolicy==='retain-outside-issues'&&oldKeys.has(issueKey(i))&&isOutside(i)));
  const outsidePoseChanges=scope.frozenRefs.filter(ref=>!samePose(model.components.get(ref),plan.components.find(c=>c.ref===ref)));
  const outsideLabelChanges=compilation.baseline.plan.labels.filter(l=>!moving.has(l.owner)).filter(l=>digest(l)!==digest(plan.labels.find(p=>p.id===l.id))).map(l=>l.id);
  const standaloneChanges=compilation.baseline.plan.testPads.filter(p=>{const q=plan.testPads.find(q=>q.id===p.id);return !q||!near(p.x,q.x)||!near(p.y,q.y)||!sameBox(p.bbox,q.bbox)||p.net!==q.net;}).map(p=>p.id);
  const areaViolations=actual.geometry.physical.filter(p=>moving.has(p.ref)&&!within(p.bbox,request.region.boundsMil)).map(p=>p.ref);
  const physicalIssues=[];
  for(let i=0;i<actual.geometry.physical.length;i++)for(let j=i+1;j<actual.geometry.physical.length;j++){
    const a=actual.geometry.physical[i],b=actual.geometry.physical[j];if(!moving.has(a.ref)&&!moving.has(b.ref))continue;
    const gap=Math.max(a.bbox.minX-b.bbox.maxX,b.bbox.minX-a.bbox.maxX,a.bbox.minY-b.bbox.maxY,b.bbox.minY-a.bbox.maxY),required=model.pairClearanceMap.get(JSON.stringify([a.ref,b.ref].sort()))??model.mechanical.clearanceMil;
    if(gap<required-1e-4)physicalIssues.push({code:'FINE_PHYSICAL_GAP',refs:[a.ref,b.ref],gapMil:gap,requiredMil:required});
  }
  const reservationIssues=request.reservedRegions.flatMap(r=>{
    const rows=r.geometry==='physical'?actual.geometry.physical:r.geometry==='assembly'?actual.geometry.assembly:actual.geometry.placement;
    return rows.filter(p=>moving.has(p.ref)&&Math.min(p.bbox.maxX,r.boundsMil.maxX)>Math.max(p.bbox.minX,r.boundsMil.minX)+1e-4&&Math.min(p.bbox.maxY,r.boundsMil.maxY)>Math.max(p.bbox.minY,r.boundsMil.minY)+1e-4).map(p=>({id:r.id,ref:p.ref}));
  });
  const sourceLimits=measureSourceLimits(model,plan,moving);
  const relations=request.relations.map(r=>{
    const beforeMil=compilation.baselineRelations.find(p=>p.id===r.id).distanceMil,afterMil=relationDistance(model,plan.components,r),caps=[...(r.maxDistanceMil!==undefined?[r.maxDistanceMil]:[]),...(r.nonRegression?[beforeMil+r.nonRegression.toleranceMil]:[])];
    return {id:r.id,source:r.source??null,basis:r.basis,net:r.net,from:r.from,to:r.to,weight:r.weight,critical:r.critical??false,beforeMil,afterMil,changeMil:afterMil-beforeMil,regressed:afterMil>beforeMil+1e-4,capsMil:caps,passed:caps.length?caps.every(c=>afterMil<=c+1e-4):r.critical?null:true,coverage:caps.length?'explicit-acceptance-rule':r.critical?'uncovered-critical-relation':'soft-objective-only'};
  });
  const unboundCritical=relations.filter(r=>r.critical&&r.passed===null).map(r=>r.id);
  const weightedBeforeMil=relations.reduce((s,r)=>s+r.weight*r.beforeMil,0),weightedAfterMil=relations.reduce((s,r)=>s+r.weight*r.afterMil,0);
  const borrowedRefs=request.region.referenceBoundsMil?actual.geometry.physical.filter(p=>moving.has(p.ref)&&!within(p.bbox,request.region.referenceBoundsMil)).map(p=>p.ref):[];
  const localAccepted=!blockingIssues.length&&!outsidePoseChanges.length&&!outsideLabelChanges.length&&!standaloneChanges.length&&!areaViolations.length&&!physicalIssues.length&&!reservationIssues.length&&sourceLimits.filter(l=>l.active).every(l=>l.passed)&&relations.every(r=>r.passed===true)&&!unboundCritical.length;
  const wholeBoardAccepted=!actual.issues.length&&sourceLimits.every(l=>l.passed)&&localAccepted;
  return {localAccepted,wholeBoardAccepted,blockingIssues,retainedOutsideIssues,outsidePreserved:!outsidePoseChanges.length&&!outsideLabelChanges.length&&!standaloneChanges.length,outsidePoseChanges,outsideLabelChanges,standaloneChanges,areaViolations,physicalIssues,reservationIssues,sourceLimits,relations,unboundCritical,weightedBeforeMil,weightedAfterMil,regressions:relations.filter(r=>r.regressed).map(r=>r.id),borrowedRefs,region:request.region,lockSources:scope.lockSources,crossingNets:scope.crossingNets,
    labelStatus:bodyOnly?'pending':request.labels.mode==='separate'?'individual-native-glyphs-checked':'joint-templates-and-placement-envelope-checked',assemblyStatus:model.assemblyPolicy?'configured-policy-checked':'explicit-envelopes-only; absent envelopes are not assembly acceptance',measurement:'Manhattan native pad-bbox-center distances; no actual copper-length, return-current or thermal claim',nativeEligible:wholeBoardAccepted&&!bodyOnly};
}
