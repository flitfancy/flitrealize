import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkConnectivity,conductiveGap,routingViaLayers} from './geometry.mjs';
import {runPythonJson} from '../lib/pcb-python.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wire=s=>({kind:'capsule',a:[s.x1,s.y1],b:[s.x2,s.y2],radius:s.width/2,layers:[s.layer]});
const via=(v,layers)=>({kind:'circle',center:[v.x,v.y],radius:v.diameter/2,layers:routingViaLayers(v,layers)});
const box=s=>{const q=s.points??[s.a??s.center,s.b??s.center],r=s.radius??0;return[Math.min(...q.map(p=>p[0]))-r,Math.min(...q.map(p=>p[1]))-r,Math.max(...q.map(p=>p[0]))+r,Math.max(...q.map(p=>p[1]))+r];};
const near=(a,b,g)=>a[0]<=b[2]+g&&b[0]<=a[2]+g&&a[1]<=b[3]+g&&b[1]<=a[3]+g;
export function routingPlacementFingerprint(board){return hash({layers:board.layers,pads:board.pads.map(p=>({id:p.id,net:p.net,x:p.x,y:p.y,shapes:p.contactShapes??p.shapes})).sort((a,b)=>a.id.localeCompare(b.id)),bounds:board.bounds??board.boardBounds??null,keepouts:board.keepouts??[]});}

/** Compose only complete paths from the same frozen pad/board geometry. */
export function buildRouteConflictGraph({board,trials,nets,clearanceMil,drillSpacingMil,sensitivePairs=[],budget}) {
  budget?.assertRemaining();
  if(!Array.isArray(nets)||!nets.length||!Array.isArray(trials)||!trials.length||!Number.isFinite(clearanceMil)||!Number.isFinite(drillSpacingMil))throw Error('COMPOSITION_INPUT_REQUIRED');
  const fingerprint=routingPlacementFingerprint(board),variants=[],byNet=Object.fromEntries(nets.map(n=>[n,[]]));
  for(const t of trials)if((t.board?routingPlacementFingerprint(t.board):t.placementFingerprint)!==fingerprint)throw Error('COMPOSITION_PLACEMENT_MISMATCH:'+t.id);
  for(const net of nets){
    budget?.assertRemaining();
    const seen=new Set(),pads=board.pads.filter(p=>p.net===net).map(p=>({...p,shapes:p.contactShapes??p.shapes}));
    for(const t of trials){
      const segments=t.candidate.segments.filter(s=>s.net===net),vias=t.candidate.vias.filter(v=>v.net===net);
      if(!checkConnectivity(net,pads,segments,vias,{layers:board.layers}).connected)continue;
      const geometryHash=hash({segments:segments.map(s=>[s.layer,s.width,s.x1,s.y1,s.x2,s.y2]).sort(),vias:vias.map(v=>[v.x,v.y,v.diameter,v.hole,[...routingViaLayers(v,board.layers)].sort((a,b)=>a-b)]).sort()});
      if(seen.has(geometryHash))continue;seen.add(geometryHash);
      const variant={id:variants.length,net,trial:t.id,segments:structuredClone(segments),vias:structuredClone(vias),geometryHash,viaCount:vias.length,lengthMm:segments.reduce((x,s)=>x+Math.hypot(s.x2-s.x1,s.y2-s.y1)*.0254,0)};
      // Trial metadata is not connectivity evidence. Recompute actual contacts.
      variants.push(variant);byNet[net].push(variant.id);
    }
  }
  const shapes=variants.map(v=>[...v.segments.map(s=>({shape:wire(s),via:null})),...v.vias.map(s=>({shape:via(s,board.layers),via:s}))].map(s=>({...s,bbox:box(s.shape)}))),conflicts=[];
  for(let a=0;a<variants.length;a++)for(let b=0;b<a;b++){
    budget?.assertRemaining();
    if(variants[a].net===variants[b].net)continue;
    const pair=sensitivePairs.find(p=>p.nets.includes(variants[a].net)&&p.nets.includes(variants[b].net)),gap=pair?.minimumMil??clearanceMil;
    if(shapes[a].some(x=>shapes[b].some(y=>{
      if(!x.shape.layers.some(l=>y.shape.layers.includes(l))||!near(x.bbox,y.bbox,Math.max(gap,drillSpacingMil)))return false;
      return conductiveGap(x.shape,y.shape)<gap-1e-5||x.via&&y.via&&Math.hypot(x.via.x-y.via.x,x.via.y-y.via.y)<drillSpacingMil-1e-5;
    })))conflicts.push([a,b]);
  }
  return{schemaVersion:1,kind:'flitrealize.route-conflict-graph',placementFingerprint:fingerprint,variants,byNet,conflicts,immutablePositions:true,nativeWrites:0,scope:'complete-route alternatives only; not proof of global routing impossibility'};
}

export async function selectCompatibleRoutes(dataset,{forceNets=[],viaWeight=100000,lengthWeight=100,maxSeconds=60,workers=8,python,timeoutMs,budget}={}) {
  budget?.assertRemaining();
  if(!Number.isFinite(maxSeconds)||maxSeconds<=0||timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw Error('COMPOSITION_BUDGET_INVALID');
  const limitMs=Math.max(1,Math.floor(Math.min(timeoutMs??(maxSeconds+10)*1000,budget?.remainingMs()??Infinity)));
  const settings={forceNets,viaWeight,lengthWeight,maxSeconds:Math.min(maxSeconds,limitMs/1000),workers};
  if(forceNets.some(n=>!Object.hasOwn(dataset.byNet,n)))throw Error('COMPOSITION_FORCE_NET_UNDECLARED');
  const result=await runPythonJson(fileURLToPath(new URL('./route-select.py',import.meta.url)),{...dataset,settings},{python,timeoutMs:limitMs});
  if(!result.selectedIds)return result;
  const selected=result.selectedIds.map(i=>dataset.variants[i]);
  return{...result,candidate:{segments:selected.flatMap(v=>v.segments).map((s,i)=>({...s,id:'composed-line-'+i})),vias:selected.flatMap(v=>v.vias).map((v,i)=>({...v,id:'composed-via-'+i}))},nativeWrites:0,requiresFullCopperVerification:true};
}
