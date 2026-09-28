// Finite shapes + top-down row order + gravity landing. Migrated from the project prototype.
import { buildShapeLibrary } from './pcb-gravity-shapes.mjs';
import { compileGeometryViews, buildGeometryViews } from './pcb-layout-geometry-views.mjs';
import { compileAssemblyPolicy } from './pcb-layout-assembly-policy.mjs';
import { layoutRealization } from './pcb-layout-provider.mjs';
import { resolveBoardBounds } from './pcb-layout-board.mjs';
import { compileEdgeRules, checkEdges } from './pcb-layout-edge.mjs';
import { transformBox } from './pcb-layout-geometry.mjs';

export function packFineLayout({snapshot:current,spatial,layout,features,geometryViews,assemblyRules,mechanical,options={}}) {
if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['marginMil','gridMil','edgeReserveMil','trials','fixedRefs','reservedRegions'].includes(k)))throw Error('INVALID_PACKING_OPTIONS');
if(!Array.isArray(options.fixedRefs??[])||!Array.isArray(options.reservedRegions??[]))throw Error('INVALID_PACKING_OPTIONS');
if(!mechanical?.expectedDocumentUuid||!mechanical?.expectedProjectUuid||current.document?.uuid!==mechanical.expectedDocumentUuid || current.document?.parentProjectUuid!==mechanical.expectedProjectUuid)throw Error('TARGET_MISMATCH');
if(!assemblyRules)throw Error('ASSEMBLY_RULES_REQUIRED');
if(!Array.isArray(current.components)||!current.components.length||!Array.isArray(current.pads)||!Array.isArray(current.items)||!Array.isArray(current.outlines)||!Array.isArray(current.regions))throw Error('INCOMPLETE_SNAPSHOT');
if(!['Line','Arc','Polyline','Via','Pour'].every(k=>Number.isInteger(current.routing?.[k])&&current.routing[k]>=0))throw Error('ROUTING_OBSERVATION_REQUIRED');
const target={expectedProjectUuid:mechanical.expectedProjectUuid,expectedDocumentUuid:mechanical.expectedDocumentUuid};
const native=layoutRealization(current,null,layout.provider,mechanical);
const resolved=resolveBoardBounds(native.board,layout.hard?.boardBounds,mechanical.boardBounds);
if(native.board.status==='none') {
 const b=resolved.bounds;
 return {status:'board-outline-required',algorithmName:'1.5维重力算法',nativeWrites:0,board:resolved,boardOutlineRequest:b?{mode:'plan',...target,rect:{originX:b.minX,originY:b.minY,widthMil:b.maxX-b.minX,heightMil:b.maxY-b.minY},lineWidthMil:10}:null};
}
const board=resolved.bounds;
const near=(a,b)=>Math.abs(a-b)<.002;
const marginMil=options.marginMil??5,gridMil=options.gridMil??5,edgeReserveMil=options.edgeReserveMil??200;
if(!Number.isFinite(marginMil)||marginMil<0||!Number.isFinite(edgeReserveMil)||edgeReserveMil<0||!Number.isFinite(gridMil)||gridMil<=0||(board.maxX-board.minX)/gridMil>20000)throw Error('INVALID_PACKING_DIMENSIONS');
const trials=options.trials??[
 {name:'top-down-left-right-original',tieMode:'original'},
 {name:'top-down-left-right-left',tieMode:'left'},
 {name:'top-down-left-right-right',tieMode:'right'},
 {name:'top-down-left-right-center',tieMode:'center'},
 {name:'top-down-left-right-reserve-edge',tieMode:'center',edgeReserveWeight:.4},
 {name:'top-down-left-right-short-edge',tieMode:'left',edgeHeightWeight:1},
];
if(!Array.isArray(trials)||!trials.length||trials.length>20||new Set(trials.map(t=>t.name)).size!==trials.length||trials.some(t=>!t.name||!['original','left','right','center'].includes(t.tieMode??'original')||[t.edgeReserveWeight??0,t.edgeHeightWeight??0].some(n=>!Number.isFinite(n)||n<0)))throw Error('INVALID_PACKING_TRIALS');
for(const trial of trials)if(Object.keys(trial).some(k=>!['name','tieMode','edgeReserveWeight','edgeHeightWeight','forceHorizontalRefs'].includes(k))||!Array.isArray(trial.forceHorizontalRefs??[]))throw Error('INVALID_PACKING_TRIALS');
const geometryModel=compileGeometryViews(current,geometryViews);
geometryModel.assemblyPolicy=compileAssemblyPolicy(current,assemblyRules);
const assembly=buildGeometryViews(geometryModel,current.components).assembly.map(item=>({ref:item.ref,id:item.id,bbox:item.bbox}));
if(assembly.length!==current.components.length+current.pads.filter(p=>!p.owner).length)throw Error('Assembly object count changed');
const byRef=new Map(assembly.map(a=>[a.ref,a]));
if(byRef.size!==assembly.length)throw Error('Duplicate assembly refs');

// Overlapping localGroups share a physical component. Merge them into one move unit.
const groups=spatial.localGroups??[];
if(!Array.isArray(groups)||new Set(groups.map(g=>g.id)).size!==groups.length||groups.some(g=>!g.id||!Array.isArray(g.refs)||!g.refs.length||new Set(g.refs).size!==g.refs.length||(g.anchor!==undefined&&!g.refs.includes(g.anchor))))throw Error('INVALID_LOCAL_GROUPS');
const parent=groups.map((_,i)=>i);
function root(i){while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i]}return i}
function join(a,b){a=root(a);b=root(b);if(a!==b)parent[b]=a}
const owner=new Map();
for(let i=0;i<groups.length;i++)for(const ref of groups[i].refs){
  if(!byRef.has(ref))throw Error(`Unknown group member: ${ref}`);
  if(owner.has(ref))join(i,owner.get(ref));else owner.set(ref,i);
}
const merged=new Map();
for(let i=0;i<groups.length;i++){
  const key=root(i),entry=merged.get(key)??{ids:[],refs:new Set(),anchorRef:groups[i].anchor??groups[i].refs[0]};
  entry.ids.push(groups[i].id);for(const ref of groups[i].refs)entry.refs.add(ref);merged.set(key,entry);
}
const units=[...merged.values()].map(g=>({id:g.ids.join('+'),refs:[...g.refs],anchorRef:g.anchorRef}));
for(const obj of assembly)if(!owner.has(obj.ref))units.push({id:obj.ref,refs:[obj.ref],anchorRef:obj.ref});
const fixedRefs=new Set([...(options.fixedRefs??[]),...(mechanical.lockedDesignators??[]),...current.components.filter(c=>c.locked).map(c=>c.ref),...current.pads.filter(p=>!p.owner&&p.locked).map(p=>p.number)]);
for(const f of layout.hard?.fixed??[]){const c=current.components.find(c=>c.ref===f.ref);if(!c||!near(c.x,f.x)||!near(c.y,f.y)||!near(c.rotation,f.rotation))throw Error('FIXED_POSITION_MISMATCH '+f.ref);fixedRefs.add(f.ref);}
for(const ref of fixedRefs)if(!byRef.has(ref))throw Error('UNKNOWN_FIXED_REF '+ref);
for(const t of trials)for(const ref of t.forceHorizontalRefs??[])if(!byRef.has(ref))throw Error('UNKNOWN_HORIZONTAL_REF '+ref);
for(const u of units)u.fixed=u.refs.some(ref=>fixedRefs.has(ref));
function boxUnion(boxes){return {minX:Math.min(...boxes.map(b=>b.minX)),maxX:Math.max(...boxes.map(b=>b.maxX)),
  minY:Math.min(...boxes.map(b=>b.minY)),maxY:Math.max(...boxes.map(b=>b.maxY))}}
for(const u of units){u.boxes=u.refs.map(ref=>byRef.get(ref).bbox);u.bbox=boxUnion(u.boxes);
  u.area=u.boxes.reduce((sum,b)=>sum+(b.maxX-b.minX)*(b.maxY-b.minY),0)}
if(new Set(units.flatMap(u=>u.refs)).size!==assembly.length)throw Error('Move units are not a partition');
const minX=board.minX+marginMil,maxX=board.maxX-marginMil,
  minY=board.minY+marginMil,maxY=board.maxY-marginMil;
const rotationRestrictions={...(layout.hard.allowedRotationDeltasByRef??{})};
for(const f of features.components??[])if(f.allowedRotationDeltas)rotationRestrictions[f.ref]=rotationRestrictions[f.ref]?rotationRestrictions[f.ref].filter(d=>f.allowedRotationDeltas.includes(d)):f.allowedRotationDeltas;
for(const [ref,values] of Object.entries(rotationRestrictions))if(!byRef.has(ref)||!Array.isArray(values)||!values.length||values.some(d=>![0,90,180,270].includes(d)))throw Error('INVALID_ROTATION_RESTRICTION '+ref);
const shapeLibrary=buildShapeLibrary(units,current,{rotationDeltas:layout.hard.preserveRotations?[0]:layout.search.rotationDeltas,
  allowedRotationDeltasByRef:rotationRestrictions});
const oversize=units.filter(u=>!u.variants.some(v=>v.bbox.maxX-v.bbox.minX<=maxX-minX && v.bbox.maxY-v.bbox.minY<=maxY-minY));
const originalExtent=boxUnion(assembly.map(a=>a.bbox));
function candidatesForX(variant,settled){
  const width=variant.bbox.maxX-variant.bbox.minX, hi=maxX-width;
  if(hi<minX)return [];
  const values=[minX,hi];
  for(let x=minX;x<=hi;x+=gridMil)values.push(x);
  const normalized=(variant.bbox.minX-originalExtent.minX)/Math.max(1,originalExtent.maxX-originalExtent.minX-width);
  values.push(minX+normalized*(hi-minX));
  for(const a of variant.boxes)for(const b of settled){
    values.push(variant.bbox.minX+b.maxX-a.minX,variant.bbox.minX+b.minX-a.maxX);
  }
  return [...new Set(values.filter(x=>x>=minX-.001&&x<=hi+.001).map(x=>Math.max(minX,Math.min(hi,x)).toFixed(4)))].map(Number);
}
function trialDrop(unit,variant,left,settled,landing='drop'){
  const tx=left-variant.bbox.minX;
  let ty=landing==='top-edge'?maxY-variant.bbox.maxY:minY-variant.bbox.minY;
  if(landing==='drop')for(const a of variant.boxes)for(const b of settled){
    if(a.minX+tx<b.maxX-.0001 && a.maxX+tx>b.minX+.0001)ty=Math.max(ty,b.maxY-a.minY);
  }
  if(variant.bbox.maxY+ty>maxY+.0001||variant.bbox.minY+ty<minY-.0001)return null;
  const boxes=variant.objects.map(o=>({ref:o.ref,minX:o.bbox.minX+tx,maxX:o.bbox.maxX+tx,
    minY:o.bbox.minY+ty,maxY:o.bbox.maxY+ty}));
  if(boxes.some(a=>settled.some(b=>a.minX<b.maxX-.0001&&a.maxX>b.minX+.0001&&a.minY<b.maxY-.0001&&a.maxY>b.minY+.0001)))return null;
  const poses=variant.objects.map(o=>({ref:o.ref,x:o.x+tx,y:o.y+ty,rotation:o.rotation}));
  return {id:unit.id,refs:unit.refs,variant:variant.name,alterationCost:variant.alterationCost,
    landing,dx:tx,dy:ty,boxes,poses,bbox:boxUnion(boxes)};
}
const edgeInputs=[...(features.components??[]).filter(f=>f.edge).map(f=>({ref:f.ref,...(f.edge===true?{}:f.edge)})),...(layout.hard.edgePlacement??[])];
const exactEdgeRules=compileEdgeRules(edgeInputs,new Map(current.components.map(c=>[c.ref,c])));
const edgeByRef=new Map(edgeInputs.filter(f=>f.onEdge!==false).map(f=>[f.ref,f]));
function edgePlacementOK(trial){
  const boxByRef=new Map(trial.boxes.map(b=>[b.ref,b]));
  for(const pose of trial.poses){
    const rule=edgeByRef.get(pose.ref);if(!rule)continue;
    const b=boxByRef.get(pose.ref),w=b.maxX-b.minX,h=b.maxY-b.minY;
    const distances={left:b.minX-board.minX,right:board.maxX-b.maxX,
      top:b.minY-board.minY,bottom:board.maxY-b.maxY};
    const outward=rule.outwardAtRotation0===undefined?null:['top','right','bottom','left'][(['top','right','bottom','left'].indexOf(rule.outwardAtRotation0)+((Math.round(pose.rotation/90)%4)+4)%4)%4];
    const valid=Object.entries(distances).some(([side,d])=>d<=marginMil+.1&&
      (!outward||side===outward)&&(!rule.sides||rule.sides.includes(side))&&
      (rule.alignment!=='long-side'||((side==='left'||side==='right')?h>=w:w>=h)));
    if(!valid)return false;
  }
  return true;
}
function validate(placed){
  const boxes=placed.flatMap(p=>p.boxes);
  for(const b of boxes)if(b.minX<minX-.001||b.maxX>maxX+.001||b.minY<minY-.001||b.maxY>maxY+.001)
    throw Error(`Out of board: ${b.ref}`);
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    if(boxes[i].ref===boxes[j].ref)throw Error('Duplicate placement');
    if(boxes[i].minX<boxes[j].maxX-.0001 && boxes[i].maxX>boxes[j].minX+.0001 &&
       boxes[i].minY<boxes[j].maxY-.0001 && boxes[i].maxY>boxes[j].minY+.0001)
      throw Error(`Assembly overlap: ${boxes[i].ref}/${boxes[j].ref}`);
  }
}
function pack(name,ordered,{tieMode='original',edgeReserveWeight=0,edgeHeightWeight=0,forceHorizontalRefs=[]}={}){
  const settled=[],placed=[],unplaced=[];
  for(const region of [...current.regions,...(options.reservedRegions??[])]){const b=region.bbox;if(!b||!['minX','minY','maxX','maxY'].every(k=>Number.isFinite(b[k]))||b.maxX<=b.minX||b.maxY<=b.minY)throw Error('REGION_GEOMETRY_REQUIRED');settled.push({...b,ref:'reserved-region'});}
  for(const u of ordered.filter(u=>u.fixed)){
    const v=u.variants.find(v=>v.name==='rigid@0');if(!v)throw Error('FIXED_SHAPE_MISSING '+u.id);
    const boxes=v.objects.map(o=>({ref:o.ref,...o.bbox}));
    if(boxes.some(a=>settled.some(b=>a.minX<b.maxX-.0001&&a.maxX>b.minX+.0001&&a.minY<b.maxY-.0001&&a.maxY>b.minY+.0001)))throw Error('FIXED_REGION_OVERLAP '+u.id);
    placed.push({id:u.id,refs:u.refs,variant:v.name,fixed:true,alterationCost:0,landing:'fixed',dx:0,dy:0,boxes,poses:v.objects.map(o=>({ref:o.ref,x:o.x,y:o.y,rotation:o.rotation})),bbox:u.bbox});settled.push(...boxes);
  }
  validate(placed);
  for(const unit of ordered.filter(u=>!u.fixed)){
    let best=null;
    const edgeUnit=unit.refs.some(ref=>edgeByRef.has(ref));
    for(const variant of unit.variants)for(const x of candidatesForX(variant,settled))for(const landing of edgeUnit?['drop','top-edge']:['drop']){
      if(unit.refs.some(ref=>forceHorizontalRefs.includes(ref))&&variant.bbox.maxX-variant.bbox.minX<variant.bbox.maxY-variant.bbox.minY)continue;
      const trial=trialDrop(unit,variant,x,settled,landing);
      if(!trial||!edgePlacementOK(trial))continue;
      const top=trial.bbox.maxY;
      const normalized=(unit.bbox.minX-originalExtent.minX)/Math.max(1,originalExtent.maxX-originalExtent.minX);
      const preferred=minX+normalized*(maxX-minX-(variant.bbox.maxX-variant.bbox.minX));
      const tie=tieMode==='left'?trial.bbox.minX:tieMode==='right'?-trial.bbox.minX:
        tieMode==='center'?Math.abs((trial.bbox.minX+trial.bbox.maxX)/2-(minX+maxX)/2):Math.abs(trial.bbox.minX-preferred);
      const edgePenalty=edgeUnit?0:Math.max(0,edgeReserveMil-(trial.bbox.minX-minX))+Math.max(0,edgeReserveMil-(maxX-trial.bbox.maxX));
      const objective=top+edgeReserveWeight*edgePenalty+
        (edgeUnit?edgeHeightWeight*(trial.bbox.maxY-trial.bbox.minY):0);
      if(!best || objective<best.objective-.001 || (near(objective,best.objective)&&trial.alterationCost<best.alterationCost) ||
         (near(objective,best.objective)&&trial.alterationCost===best.alterationCost&&tie<best.tie))best={...trial,top,tie,objective};
    }
    if(!best){unplaced.push(unit.id);continue}
    const {top,tie,objective,...result}=best;placed.push(result);settled.push(...result.boxes);
    // Early validation checkpoint, then verify every accepted step.
    validate(placed);
  }
  return {name,complete:unplaced.length===0,placedUnitCount:placed.length,placedObjectCount:placed.reduce((n,u)=>n+u.boxes.length,0),
    totalUnitCount:units.length,totalObjectCount:assembly.length,unplaced,usedTopMil:placed.length?Math.max(...placed.flatMap(u=>u.boxes.map(b=>b.maxY))):null,placed};
}
function topDownLayers(items){
  const remaining=[...items],layers=[];
  while(remaining.length){
    remaining.sort((a,b)=>b.bbox.maxY-a.bbox.maxY||a.bbox.minX-b.bbox.minX||a.id.localeCompare(b.id));
    const seed=remaining[0],row=remaining.filter(u=>u.bbox.maxY>=seed.bbox.minY-.001)
      .sort((a,b)=>a.bbox.minX-b.bbox.minX||b.bbox.maxY-a.bbox.maxY||a.id.localeCompare(b.id));
    layers.push(row);
    const ids=new Set(row.map(u=>u.id));
    for(let i=remaining.length-1;i>=0;i--)if(ids.has(remaining[i].id))remaining.splice(i,1);
  }
  return layers;
}
const layers=topDownLayers(units),ordered=layers.flat();
const runs=trials.map(({name,...parameters})=>pack(name,ordered,parameters));
const winner=[...runs].sort((a,b)=>Number(b.complete)-Number(a.complete)||b.placedObjectCount-a.placedObjectCount||a.usedTopMil-b.usedTopMil)[0];
const winnerBoxes=new Map(winner.placed.flatMap(u=>u.boxes.map(b=>[b.ref,b])));
const winnerPoses=new Map(winner.placed.flatMap(u=>u.poses.map(p=>[p.ref,p])));
const sides=['left','right','top','bottom'];
const edgeAudit=[...edgeByRef].map(([ref,edge])=>({ref,edge})).map(f=>{
  const b=winnerBoxes.get(f.ref),pose=winnerPoses.get(f.ref);
  if(!b||!pose)return{ref:f.ref,status:'unplaced'};
  const distances={left:b.minX-board.minX,right:board.maxX-b.maxX,
    top:b.minY-board.minY,bottom:board.maxY-b.maxY};
  const orientationSide=f.edge.outwardAtRotation0===undefined?null:['top','right','bottom','left'][(['top','right','bottom','left'].indexOf(f.edge.outwardAtRotation0)+((Math.round(pose.rotation/90)%4)+4)%4)%4];
  const w=b.maxX-b.minX,h=b.maxY-b.minY;
  const validSides=sides.filter(side=>distances[side]<=marginMil+.1&&(!orientationSide||orientationSide===side)&&(!f.edge.sides||f.edge.sides.includes(side))&&
    (f.edge.alignment!=='long-side'||((side==='left'||side==='right')?h>=w:w>=h)));
  const selectedSide=validSides.sort((a,b)=>distances[a]-distances[b])[0]??null;
  return{ref:f.ref,selectedSide,distanceMil:selectedSide?distances[selectedSide]:null,orientationSide,
    approximateSatisfied:validSides.length>0};
});

const packedPoses=new Map(winner.placed.flatMap(u=>u.poses.map(p=>[p.ref,p])));
let geometry=null,checks=null;
if(winner.complete){
 const cs=current.components.map(c=>{const p=packedPoses.get(c.ref);return {...c,...p,bbox:transformBox(c.bbox,c,p)};});
 const tps=current.pads.filter(p=>!p.owner).map(p=>{const next=packedPoses.get(p.number);return {...p,x:next.x,y:next.y,bbox:transformBox(p.bbox,{...p,rotation:0},{...next,rotation:0})};});
 geometry=buildGeometryViews(geometryModel,cs,undefined,tps);
 checks={assembly:geometry.assemblyPolicy,edges:checkEdges(exactEdgeRules,cs.map(c=>({...c,body:c.bbox})),board)};
}
const routingPresent=Object.values(current.routing).some(n=>n>0);
return {status:winner.complete?'packed-candidate':'partial-packing',kind:'flitrealize.pcb-gravity-layout',algorithmName:'1.5维重力算法',nativeWrites:0,sourceHash:current.sourceHash,target,board,marginMil,gridMil,originalObjects:assembly,
 unitCount:units.length,objectCount:assembly.length,shapeVariantCount:shapeLibrary.reduce((n,u)=>n+u.variantCount,0),
 fixedUnits:units.filter(u=>u.fixed).map(u=>u.id),shapeLibrary,
 selectionLayers:layers.map((row,i)=>({index:i+1,unitIds:row.map(u=>u.id)})),selectionOrder:ordered.map(u=>u.id),
 runs,selectedRun:winner.name,candidate:winner,geometry,checks,approximateEdgeAudit:edgeAudit,
 oversizedUnits:oversize.map(u=>({id:u.id,refs:u.refs})),
 execution:{mode:'offline-only',routedBoard:routingPresent,requiresNativePlan:true,standalonePadsAndLabels:'must be included in any later full application'},
 limitations:['This is finite-shape gravity packing in top-down source order; it is not global optimization or electrical routing.',
 'Contact and collision use rule-derived assembly AABBs. Edge landing is approximate; exact footprint-edge diagnostics are reported separately.',
 'Silkscreen is projected for review, not optimized. Block coupling, board-edge manufacturing, thermal, 3D and electrical intent require further validation.',
 'No native writes or component-only application request is generated. A partial packing is not a full-board candidate.']};
}
