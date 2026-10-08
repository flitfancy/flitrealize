import {checkConnectivity,conductiveGap,routingViaLayers} from './geometry.mjs';

const clone=value=>structuredClone(value),mm=.0254;
const wire=s=>({kind:'capsule',a:[s.x1,s.y1],b:[s.x2,s.y2],radius:s.width/2,layers:[s.layer]});
const via=(v,layers)=>({kind:'circle',center:[v.x,v.y],radius:v.diameter/2,layers:routingViaLayers(v,layers)});
const length=s=>Math.hypot(s.x2-s.x1,s.y2-s.y1)*mm;
const padShapes=p=>({...p,shapes:p.contactShapes??p.shapes});
const ordinaryRoles=new Set(['ordinary_signal','sensitive_signal','control_signal']);

export function protectedRoutingNets(policy,{protectedNets=[]}={}) {
  const protectedSet=new Set(protectedNets);
  for(const net of policy.nets??[])if(!net.roles?.length||net.roles.some(r=>!ordinaryRoles.has(r.name)))protectedSet.add(net.net);
  for(const pair of policy.differentialPairs??policy.pairs??[])for(const net of [pair.positiveNet,pair.negativeNet,...(Array.isArray(pair)?pair:[])])if(net)protectedSet.add(net);
  return protectedSet;
}

function validate(board,policy,nets) {
  if(policy?.units!=='mil'||!Array.isArray(board.layers)||!board.layers.length)throw Error('CLEANUP_MIL_BOARD_REQUIRED');
  if(!Array.isArray(nets)||!nets.length||new Set(nets).size!==nets.length)throw Error('CLEANUP_NET_SELECTION_REQUIRED');
  for(const net of nets){
    if(!policy.nets.some(n=>n.net===net)||board.pads.filter(p=>p.net===net).length<2)throw Error('CLEANUP_NET_UNDECLARED:'+net);
    if(!checkConnectivity(net,board.pads.filter(p=>p.net===net).map(padShapes),board.segments,board.vias,{layers:board.layers}).connected)throw Error('CLEANUP_REQUIRES_CONNECTED_NET:'+net);
  }
}

function reduceNet(board,net,segments,vias,{widths,segmentOrder='short-first'}={}) {
  const pads=board.pads.filter(p=>p.net===net).map(padShapes),removedVias=[],removedSegments=[];
  for(const v of [...vias]){if(v.locked)continue;const rest=vias.filter(w=>w!==v);if(checkConnectivity(net,pads,segments,rest,{layers:board.layers}).connected){vias=rest;removedVias.push(v.id);}}
  const eligible=segments.filter(s=>!s.locked&&(!widths||widths.some(w=>Math.abs(w-s.width)<1e-7))).sort((a,b)=>(segmentOrder==='long-first'?-1:1)*(length(a)-length(b)));
  for(const s of eligible){const rest=segments.filter(w=>w!==s);if(checkConnectivity(net,pads,rest,vias,{layers:board.layers}).connected){segments=rest;removedSegments.push(s.id);}}
  return{segments,vias,removedVias,removedSegments};
}

/** Preserve every physical pad contact; protected electrical roles remain intact. */
export function pruneCopper(board,policy,{nets,protectedNets=[],allowedWidthsByNet={},segmentOrder='short-first'}={}) {
  validate(board,policy,nets);
  if(!['short-first','long-first'].includes(segmentOrder))throw Error('INVALID_PRUNING_ORDER');
  const out=clone(board),protect=protectedRoutingNets(policy,{protectedNets}),records=[];
  const before={vias:out.vias.length,segments:out.segments.length};
  for(const net of nets){
    if(protect.has(net)){records.push({net,status:'protected'});continue;}
    const locked=out.vias.filter(v=>v.net===net&&v.locked);
    const next=reduceNet(out,net,out.segments.filter(s=>s.net===net),out.vias.filter(v=>v.net===net),{widths:allowedWidthsByNet[net],segmentOrder});
    if(locked.some(v=>!next.vias.some(w=>w.id===v.id)))throw Error('LOCKED_VIA_PRUNING');
    out.segments=out.segments.filter(s=>s.net!==net).concat(next.segments);out.vias=out.vias.filter(v=>v.net!==net).concat(next.vias);
    records.push({net,status:'connectivity-preserved',removedVias:next.removedVias,removedSegments:next.removedSegments});
  }
  return{status:'planned',board:out,before,after:{vias:out.vias.length,segments:out.segments.length},records,protectedNets:[...protect],nativeWrites:0,scope:'offline endpoint-preserving ordinary-signal copper pruning; ground/current/native DRC not verified'};
}

const bounds=s=>{const q=s.points??[s.a??s.center,s.b??s.center],r=s.radius??0;return[Math.min(...q.map(p=>p[0]))-r,Math.min(...q.map(p=>p[1]))-r,Math.max(...q.map(p=>p[0]))+r,Math.max(...q.map(p=>p[1]))+r];};
const near=(a,b,g)=>a[0]<=b[2]+g&&b[0]<=a[2]+g&&a[1]<=b[3]+g&&b[1]<=a[3]+g;
function clearanceFor(a,b,policy){
  const pairs=policy.clearances?.pairs??[];const rule=pairs.find(r=>r.nets?.includes(a)&&r.nets?.includes(b));
  if(rule)return rule.minimumMil;
  const sensitive=n=>policy.nets.find(r=>r.net===n)?.roles.some(r=>r.name==='sensitive_signal');
  const noise=n=>policy.nets.find(r=>r.net===n)?.roles.some(r=>['local_bootstrap','local_switch_power'].includes(r.name));
  return(sensitive(a)&&noise(b)||sensitive(b)&&noise(a))?(policy.clearances.minimumSensitiveToSwitchCopperMil??policy.clearances.ordinaryCopperMil):policy.clearances.ordinaryCopperMil;
}

/** Same-layer replacements are proposals; full geometry verification follows. */
export function bypassVias(board,policy,{nets,protectedNets=[],viaCostMm,layerWeights,offsetsMil=[],maxRounds=4,boardBounds=board.bounds??board.boardBounds,copperEdgeMil,keepouts=board.keepouts??[]}={}) {
  validate(board,policy,nets);
  if(!Number.isFinite(viaCostMm)||viaCostMm<0||!layerWeights||board.layers.some(l=>!Number.isFinite(layerWeights[l])||layerWeights[l]<=0)||!boardBounds||!Number.isFinite(copperEdgeMil)||!Number.isFinite(policy.clearances?.ordinaryCopperMil))throw Error('SHORTCUT_OBJECTIVE_AND_GEOMETRY_REQUIRED');
  if(!Number.isInteger(maxRounds)||maxRounds<1||!offsetsMil.every(Number.isFinite))throw Error('INVALID_SHORTCUT_SEARCH');
  const out=clone(board),protect=protectedRoutingNets(policy,{protectedNets}),records=[];let serial=0;
  const used=new Set([...board.segments,...board.vias].map(s=>s.id));
  const uniqueId=()=>{let id;do{id='via-bypass-'+serial++;}while(used.has(id));used.add(id);return id;};
  const score=(ss,vs)=>vs.length*viaCostMm+ss.reduce((x,s)=>x+length(s)*layerWeights[s.layer],0);
  for(const net of nets){
    if(protect.has(net)){records.push({net,status:'protected'});continue;}
    let ss=out.segments.filter(s=>s.net===net),vs=out.vias.filter(v=>v.net===net);const width=policy.nets.find(n=>n.net===net).defaultWireWidthMil;
    if(!Number.isFinite(width)||width<=0)throw Error('SHORTCUT_WIDTH_REQUIRED:'+net);
    const before={vias:vs.length,lengthMm:ss.reduce((x,s)=>x+length(s),0),weightedCost:score(ss,vs)};
    const foreign=[...out.pads.filter(p=>p.net!==net).flatMap(p=>p.shapes.map(shape=>({net:p.net,shape}))),...out.segments.filter(s=>s.net!==net).map(s=>({net:s.net,shape:wire(s)})),...out.vias.filter(v=>v.net!==net).map(v=>({net:v.net,shape:via(v,out.layers)}))].map(c=>({...c,bbox:bounds(c.shape)}));
    const clear=s=>{
      const shape=wire(s),b=bounds(shape),k=boardBounds;
      if(b[0]<k.minX+copperEdgeMil||b[1]<k.minY+copperEdgeMil||b[2]>k.maxX-copperEdgeMil||b[3]>k.maxY-copperEdgeMil)return false;
      if(keepouts.some(k=>conductiveGap(shape,k.shape??k)<0))return false;
      return!foreign.some(c=>{if(!c.shape.layers.includes(s.layer))return false;const gap=clearanceFor(net,c.net,policy);return near(b,c.bbox,gap)&&conductiveGap(shape,c.shape)<gap-1e-5;});
    };
    let accepted=0;
    for(let round=0;round<maxRounds;round++){
      const pairs=[];for(let a=0;a<vs.length;a++)for(let b=0;b<a;b++)if(!vs[a].locked&&!vs[b].locked)pairs.push([vs[a],vs[b]]);
      pairs.sort((a,b)=>Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)-Math.hypot(b[0].x-b[1].x,b[0].y-b[1].y));let changed=false;
      search:for(const [a,b] of pairs){
        const A=[a.x,a.y],B=[b.x,b.y],dx=B[0]-A[0],dy=B[1]-A[1],d=Math.min(Math.abs(dx),Math.abs(dy));
        const paths=[[A,B],[A,[A[0],B[1]],B],[A,[B[0],A[1]],B],[A,[A[0]+Math.sign(dx)*d,A[1]+Math.sign(dy)*d],B],[A,[B[0]-Math.sign(dx)*d,B[1]-Math.sign(dy)*d],B]];
        for(const offset of offsetsMil)paths.push([A,[A[0]+offset,A[1]],[A[0]+offset,B[1]],B],[A,[A[0],A[1]+offset],[B[0],A[1]+offset],B]);
        paths.sort((p,q)=>p.slice(1).reduce((s,v,i)=>s+Math.hypot(v[0]-p[i][0],v[1]-p[i][1]),0)-q.slice(1).reduce((s,v,i)=>s+Math.hypot(v[0]-q[i][0],v[1]-q[i][1]),0));
        for(const layer of board.layers)for(const points of paths){
          const added=points.slice(1).map((q,i)=>({id:uniqueId(),net,layer,width,x1:points[i][0],y1:points[i][1],x2:q[0],y2:q[1],kind:'same-layer-via-bypass'})).filter(s=>length(s)>1e-8);
          if(!added.every(clear))continue;
          const next=reduceNet(out,net,ss.concat(added),vs,{segmentOrder:'long-first'});
          if(next.vias.length>=vs.length||score(next.segments,next.vias)>=score(ss,vs)-1e-5)continue;
          ss=next.segments;vs=next.vias;accepted++;changed=true;break search;
        }
      }
      if(!changed)break;
    }
    out.segments=out.segments.filter(s=>s.net!==net).concat(ss);out.vias=out.vias.filter(v=>v.net!==net).concat(vs);
    records.push({net,status:'candidate',before,after:{vias:vs.length,lengthMm:ss.reduce((x,s)=>x+length(s),0),weightedCost:score(ss,vs)},accepted});
  }
  return{status:'planned',board:out,records,nativeWrites:0,scope:'offline same-layer via bypass; revalidate geometry and ground before accepting'};
}
