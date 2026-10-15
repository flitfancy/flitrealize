// Opt-in coarse placement preferences. These do not add hard routing rules.
import {angle,transformBox} from './pcb-layout-geometry.mjs';

const finite=(v,min=0)=>Number.isFinite(v)&&v>=min;
const area=b=>(b.maxX-b.minX)*(b.maxY-b.minY);
const sides=['left','right','bottom','top'];

export function compileRoughLayoutPolicy(model,problem,policy){
 if(policy===undefined)return null;
 if(!policy||policy.schemaVersion!==1||!finite(policy.groupCompactnessWeight??1)||policy.clearanceMil!==undefined&&!finite(policy.clearanceMil))throw Error('INVALID_ROUGH_LAYOUT_POLICY');
 if(problem.openPlacement||!problem.board||problem.blockObjective)throw Error('ROUGH_LAYOUT_REQUIRES_BOARD_OBJECTIVE');
 const d=policy.density,c=policy.connectionSide;
 if(d&&(!finite(d.weight)||!finite(d.cellMil,problem.settings.resolutionMil)||!finite(d.targetCount,.1)||!Array.isArray(d.offsetFractions)||!d.offsetFractions.length||d.offsetFractions.some(x=>!finite(x)||x>=1)))throw Error('INVALID_ROUGH_DENSITY');
 if(c&&(!finite(c.weight)||!Number.isInteger(c.minimumConnectedPads)||c.minimumConnectedPads<1||!Array.isArray(c.excludeNets)||!Array.isArray(c.depthLevels)||!c.depthLevels.length||c.depthLevels.some(l=>!Number.isInteger(l.minimumSidePads)||l.minimumSidePads<1||!finite(l.depthMil,problem.settings.resolutionMil))))throw Error('INVALID_CONNECTION_SIDE_POLICY');
 const out={schemaVersion:1,groupCompactnessWeight:policy.groupCompactnessWeight??1,density:null,bands:[],connectionSideWeight:c?.weight??0,limitations:['Coarse centroid counts, not occupied area or routing capacity.','Side bands are soft obstacle-count preferences, not individual pin escape corridors.','Group compactness scales existing intra-block centre relations; no extra span objective.']};
 if(d?.weight){
  const unit=problem.settings.resolutionMil,cellUnits=Math.round(d.cellMil/unit);
  const cellMil=cellUnits*unit,refs=problem.entities.filter(e=>e.kind==='component'&&Math.max(...e.variants.map(v=>area(v.physical)))<cellMil*cellMil).map(e=>e.ref);
  const grids=d.offsetFractions.map(f=>{
   const originX=Math.round((problem.board.minX-f*cellMil)/unit)*unit,originY=Math.round((problem.board.minY-f*cellMil)/unit)*unit;
   const nx=Math.ceil((problem.board.maxX-originX)/cellMil),ny=Math.ceil((problem.board.maxY-originY)/cellMil);
   const targets=[];
   for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){
    const width=Math.max(0,Math.min(problem.board.maxX,originX+(x+1)*cellMil)-Math.max(problem.board.minX,originX+x*cellMil));
    const height=Math.max(0,Math.min(problem.board.maxY,originY+(y+1)*cellMil)-Math.max(problem.board.minY,originY+y*cellMil));
    targets.push(Math.ceil(d.targetCount*width*height/(cellMil*cellMil)*10-1e-7));
   }
   return {originX,originY,nx,ny,targets};
  });
  if(grids.reduce((n,g)=>n+g.nx*g.ny,0)*refs.length>30000)throw Error('ROUGH_DENSITY_MODEL_TOO_LARGE');
  out.density={weight:d.weight,cellMil,cellUnits,targetCount:d.targetCount,countScale:10,refs,grids};
 }
 if(c?.weight){
  const excluded=new Set(c.excludeNets),pads=new Map(model.pads.map(p=>[p.id,p])),pending=[],netOwners=new Map();
  for(const p of model.pads){if(!netOwners.has(p.net))netOwners.set(p.net,new Set());netOwners.get(p.net).add(p.owner??p.number);}
  const relations=model.contract.extensions?.pcbLayout?.relations??[];
  const levels=[...c.depthLevels].sort((a,b)=>a.minimumSidePads-b.minimumSidePads);
  for(const e of problem.entities){
   if(e.kind!=='component')continue;
   const v=e.variants[0],counts=Object.fromEntries(sides.map(s=>[s,[]]));
   const used=Object.entries(v.padCenters).filter(([id])=>pads.get(id)?.net&&!excluded.has(pads.get(id).net)&&[...(netOwners.get(pads.get(id).net)??[])].some(owner=>owner!==e.ref));
   if(used.length<c.minimumConnectedPads)continue;
   for(const [id,p] of used){
    const distances=[Math.abs(p.x-v.physical.minX),Math.abs(p.x-v.physical.maxX),Math.abs(p.y-v.physical.minY),Math.abs(p.y-v.physical.maxY)];
    counts[sides[distances.indexOf(Math.min(...distances))]].push(id);
   }
   const exempt=new Set([e.ref,...(c.exemptRefsByOwner?.[e.ref]??[])]);
   for(const r of relations)if(r.to.ref===e.ref&&(c.exemptRelationKinds??['bypass','bootstrap','power-path']).includes(r.kind))exempt.add(r.from.ref);
   for(const side of sides){
    const ids=counts[side],level=levels.filter(l=>ids.length>=l.minimumSidePads).at(-1);if(!level)continue;
    const b=v.physical,depth=level.depthMil;
    const band=side==='left'?{...b,minX:b.minX-depth,maxX:b.minX}:side==='right'?{...b,minX:b.maxX,maxX:b.maxX+depth}:side==='bottom'?{...b,minY:b.minY-depth,maxY:b.minY}:{...b,minY:b.maxY,maxY:b.maxY+depth};
    const index=(e.variants[0].roughBands??[]).length;
    for(const variant of e.variants){variant.roughBands??=[];variant.roughBands.push(transformBox(band,{x:0,y:0,rotation:v.rotation},{x:0,y:0,rotation:variant.rotation}));}
    pending.push({id:e.ref+':'+side,owner:e.ref,index,sideAtFirstVariant:side,depthMil:depth,padIds:ids,connectedPads:ids.length,ownerConnectedPads:used.length,weight:ids.length/used.length,peerRefs:problem.entities.filter(p=>p.kind==='component'&&!exempt.has(p.ref)).map(p=>p.ref),exemptRefs:[...exempt].filter(r=>r!==e.ref)});
   }
  }
  const ownerCount=new Set(pending.map(b=>b.owner)).size;
  out.bands=pending.map(b=>({...b,weight:b.weight/Math.max(1,ownerCount)}));
 }
 problem.roughLayout=out;
 problem.coverage.objective.roughLayout={groupCompactnessWeight:out.groupCompactnessWeight,density:out.density?'two-offset coarse centroid windows':'disabled',connectionSides:out.bands.length,hardRules:'unchanged'};
 return out;
}

// Recompute the exact quantized proxies from decoded poses, independent of CP-SAT.
export function roughLayoutMetrics(problem,plan){
 const policy=problem.roughLayout;if(!policy)return null;
 const poses=new Map(plan.components.map(p=>[p.ref,p])),unit=problem.settings.resolutionMil;
 const boxes=new Map(),variants=new Map();
 const quantBox=(e,v,b)=>{
  const p=poses.get(e.ref);if(!p)throw Error('ROUGH_METRIC_POSE_MISSING '+e.ref);
  const delta={x:Math.round((p.x-e.base.x-(v.originOffset?.x??0))/unit),y:Math.round((p.y-e.base.y-(v.originOffset?.y??0))/unit)};
  return Object.fromEntries(['minX','minY','maxX','maxY'].map(k=>{const axis=k.endsWith('X')?'x':'y',value=(e.base[axis]+(v.originOffset?.[axis]??0)+b[k])/unit;return [k,delta[axis]+(k.startsWith('min')?Math.floor(value+1e-7):Math.ceil(value-1e-7))];}));
 };
 for(const e of problem.entities){const pose=poses.get(e.ref);if(!pose)continue;const v=e.variants.find(v=>angle(v.rotation)===angle(pose.rotation));if(!v)throw Error('ROUGH_METRIC_ROTATION '+e.ref);variants.set(e.ref,{e,v});boxes.set(e.ref,quantBox(e,v,v.physical));}
 let densityPenalty=0;const grids=[];
 if(policy.density){
  const d=policy.density;
  for(const g of d.grids){
   const counts=Array(g.nx*g.ny).fill(0),members=counts.map(()=>[]),ox=Math.round(g.originX/unit),oy=Math.round(g.originY/unit);
   for(const ref of d.refs){const b=boxes.get(ref);const x=Math.max(0,Math.min(g.nx-1,Math.floor((b.minX+b.maxX-2*ox)/(2*d.cellUnits)))),y=Math.max(0,Math.min(g.ny-1,Math.floor((b.minY+b.maxY-2*oy)/(2*d.cellUnits))));counts[y*g.nx+x]++;members[y*g.nx+x].push(ref);}
   const penalty=counts.reduce((n,count,i)=>n+Math.max(0,count*d.countScale-g.targets[i])**2/(d.countScale*d.targetCount)**2,0);
   densityPenalty+=penalty/d.grids.length;grids.push({...g,counts,members,penalty,peakCount:Math.max(...counts),overTargetCells:counts.filter((n,i)=>n*d.countScale>g.targets[i]).length});
  }
 }
 const bands=policy.bands.map(rule=>{const {e,v}=variants.get(rule.owner),b=quantBox(e,v,v.roughBands[rule.index]);const overlaps=rule.peerRefs.filter(ref=>{const p=boxes.get(ref);return Math.min(b.maxX,p.maxX)>Math.max(b.minX,p.minX)&&Math.min(b.maxY,p.maxY)>Math.max(b.minY,p.minY);});return {...rule,boxMil:Object.fromEntries(Object.entries(b).map(([k,n])=>[k,n*unit])),overlaps,penalty:overlaps.length*rule.weight};});
 const connectionSidePenalty=bands.reduce((n,b)=>n+b.penalty,0);
 return {densityPenalty,connectionSidePenalty,weightedScore:densityPenalty*(policy.density?.weight??0)+connectionSidePenalty*policy.connectionSideWeight,groupCompactnessWeight:policy.groupCompactnessWeight,grids,bands,limitations:policy.limitations};
}
