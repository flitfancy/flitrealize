// Copper-centreline projection metrics, not an electromagnetic/current model.
import {conductiveContact,routingLayers,routingViaLayers} from './geometry.mjs';
const EPS=1e-7,MIL=.0254,dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const lineShape=s=>({kind:'capsule',a:s.a,b:s.b,radius:s.width/2,layers:[s.layer]});
const circle=(v,layers)=>({kind:'circle',center:[v.x,v.y],radius:v.diameter/2,layers:routingViaLayers(v,layers)});
function projection(p,a,b){const x=b[0]-a[0],y=b[1]-a[1],d=x*x+y*y,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y)/d)):0;return{t,p:[a[0]+t*x,a[1]+t*y]};}
function inside(p,polygon){let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function nearestShape(p,s){if(s.kind==='circle'){const d=dist(p,s.center);return d<=s.radius?p:[s.center[0]+(p[0]-s.center[0])*s.radius/d,s.center[1]+(p[1]-s.center[1])*s.radius/d];}if(inside(p,s.points))return p;return s.points.map((a,i)=>projection(p,a,s.points[(i+1)%s.points.length]).p).sort((a,b)=>dist(a,p)-dist(b,p))[0];}
function crossing(a,b){const x=a.b[0]-a.a[0],y=a.b[1]-a.a[1],u=b.b[0]-b.a[0],v=b.b[1]-b.a[1],den=x*v-y*u;if(Math.abs(den)<EPS)return null;const px=b.a[0]-a.a[0],py=b.a[1]-a.a[1],t=(px*v-py*u)/den,q=(px*y-py*x)/den;return t>=-EPS&&t<=1+EPS&&q>=-EPS&&q<=1+EPS?{t:Math.max(0,Math.min(1,t)),q:Math.max(0,Math.min(1,q))}:null;}
export function createCopperPathGraph(board,net,{budget}={}){
 if(!Array.isArray(board?.layers)||!board.layers.length)throw Error('EXPLICIT_BOARD_LAYERS_REQUIRED');
 routingLayers(board.layers);for(const via of board.vias)routingViaLayers(via,board.layers);
 budget?.assertRemaining();
 const layers=board.layers,wires=board.segments.filter(s=>s.net===net).map((s,i)=>({...s,index:i,a:[s.x1,s.y1],b:[s.x2,s.y2],ts:new Set([0,1])})),pads=board.pads.filter(p=>p.net===net),vias=board.vias.filter(v=>v.net===net),nodes=[],adj=[],keys=new Map(),padNodes=new Map(),links=[];
 const node=(p,layer)=>{const key=layer+':'+p.map(x=>Math.round(x/EPS)).join(',');if(!keys.has(key)){keys.set(key,nodes.length);nodes.push({x:p[0],y:p[1],layer});adj.push([]);}return keys.get(key);};
 const edge=(a,b,length,kind,reference=null,changes=0)=>{if(a===b)return;adj[a].push({to:b,length,kind,reference,changes});adj[b].push({to:a,length,kind,reference,changes});};
 const at=(s,t)=>[s.a[0]+(s.b[0]-s.a[0])*t,s.a[1]+(s.b[1]-s.a[1])*t],split=(s,t)=>{const rounded=Math.round(t*1e10)/1e10;s.ts.add(rounded);return node(at(s,rounded),s.layer);},wireTransfer=(a,ta,b,tb)=>{const pa=at(a,ta),pb=at(b,tb);if(dist(pa,pb)<=a.width/2+b.width/2+.08)links.push({a:split(a,ta),b:split(b,tb),length:dist(pa,pb),kind:'wire-contact'});};
 const wirePairs=[];
 for(let i=0;i<wires.length;i++)for(let j=i+1;j<wires.length;j++){if((j&63)===0)budget?.assertRemaining();const a=wires[i],b=wires[j];if(a.layer!==b.layer||!conductiveContact(lineShape(a),lineShape(b)))continue;wirePairs.push([a,b]);const c=crossing(a,b);if(c)wireTransfer(a,c.t,b,c.q);for(const t of[0,1]){wireTransfer(a,t,b,projection(at(a,t),b.a,b.b).t);wireTransfer(a,projection(at(b,t),a.a,a.b).t,b,t);}}
 const padRegions=[];
 for(const p of pads){budget?.assertRemaining();const ids=[];for(const s of p.shapes)for(const layer of s.layers){const centre=node([p.x,p.y],layer),region={pad:p,shape:s,layer,ids:new Set([centre])};padRegions.push(region);ids.push(centre);for(const w of wires){if(w.layer!==layer||!conductiveContact(s,lineShape(w)))continue;const points=[[p.x,p.y],...s.points??[s.center],w.a,w.b];for(const q of points){const pr=projection(q,w.a,w.b),contact=nearestShape(pr.p,s);if(dist(contact,pr.p)>w.width/2+.08)continue;const padPoint=node(contact,layer),wirePoint=split(w,pr.t);region.ids.add(padPoint);links.push({a:padPoint,b:wirePoint,length:dist(contact,pr.p),kind:'pad-wire-contact',reference:p.id});}}}padNodes.set(p.id,[...new Set(ids)]);}
 // Only an explicitly plated pad transfers copper across its layer shapes.
 // Mere duplicate copper shapes do not establish a plated hole.
 for(const p of pads.filter(p=>p.plated===true)){const ids=padNodes.get(p.id);for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)if(nodes[ids[i]].layer!==nodes[ids[j]].layer)edge(ids[i],ids[j],0,'plated-pad-layer',p.id,1);}
 const viaNodes=vias.map((v,i)=>({via:v,index:i,byLayer:new Map(routingViaLayers(v,layers).map(layer=>[layer,node([v.x,v.y],layer)]))}));
 for(const v of viaNodes){budget?.assertRemaining();const entries=[...v.byLayer.values()];for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)edge(entries[i],entries[j],0,'via-layer',v.via.id??v.index,1);for(const w of wires)if(v.byLayer.has(w.layer)&&conductiveContact(circle(v.via,layers),lineShape(w))){const q=projection([v.via.x,v.via.y],w.a,w.b);links.push({a:v.byLayer.get(w.layer),b:split(w,q.t),length:dist([v.via.x,v.via.y],q.p),kind:'via-wire-contact',reference:v.via.id??v.index});}for(const p of padRegions)if(v.byLayer.has(p.layer)&&conductiveContact(circle(v.via,layers),p.shape)){const q=nearestShape([v.via.x,v.via.y],p.shape),id=node(q,p.layer);p.ids.add(id);links.push({a:v.byLayer.get(p.layer),b:id,length:dist([v.via.x,v.via.y],q),kind:'via-pad-contact',reference:v.via.id??v.index});}}
 for(let i=0;i<viaNodes.length;i++)for(let j=i+1;j<viaNodes.length;j++){const a=viaNodes[i],b=viaNodes[j];if(!conductiveContact(circle(a.via,layers),circle(b.via,layers)))continue;for(const layer of layers)if(a.byLayer.has(layer)&&b.byLayer.has(layer))edge(a.byLayer.get(layer),b.byLayer.get(layer),Math.hypot(a.via.x-b.via.x,a.via.y-b.via.y),'via-via-contact');}
 for(let i=0;i<padRegions.length;i++)for(let j=i+1;j<padRegions.length;j++){const a=padRegions[i],b=padRegions[j];if(a.layer!==b.layer||a.pad.id===b.pad.id||!conductiveContact(a.shape,b.shape))continue;const points=[[a.pad.x,a.pad.y],[b.pad.x,b.pad.y],...(a.shape.points??[a.shape.center]),...(b.shape.points??[b.shape.center])];for(const point of points){const pa=nearestShape(point,a.shape),pb=nearestShape(pa,b.shape);if(dist(pa,pb)>.08)continue;const ia=node(pa,a.layer),ib=node(pb,b.layer);a.ids.add(ia);b.ids.add(ib);links.push({a:ia,b:ib,length:dist(pa,pb),kind:'pad-pad-contact'});}}
 // Junction/terminal projections also transfer across overlapping wide copper.
 for(let sweep=0;sweep<2;sweep++)for(const[a,b]of wirePairs){for(const t of [...a.ts])wireTransfer(a,t,b,projection(at(a,t),b.a,b.b).t);for(const t of [...b.ts])wireTransfer(a,projection(at(b,t),a.a,a.b).t,b,t);}
 for(const w of wires){const ts=[...w.ts].sort((a,b)=>a-b);for(let i=1;i<ts.length;i++)edge(split(w,ts[i-1]),split(w,ts[i]),dist(at(w,ts[i-1]),at(w,ts[i])),'trace',w.index);}
 for(const p of padRegions){const ids=[...p.ids];for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)edge(ids[i],ids[j],Math.hypot(nodes[ids[i]].x-nodes[ids[j]].x,nodes[ids[i]].y-nodes[ids[j]].y),'pad-copper',p.pad.id);}
 for(const l of links)edge(l.a,l.b,l.length,l.kind,l.reference);
 function shortest(fromId,toId,{preferWide=false,normalWidthMil}={}){
  if(preferWide&&(!Number.isFinite(normalWidthMil)||normalWidthMil<=0))throw Error('NORMAL_WIDTH_REQUIRED_FOR_WIDTH_PROXY');
  const starts=padNodes.get(fromId),goals=new Set(padNodes.get(toId)??[]);if(!starts?.length||!goals.size)throw Error('PATH_ENDPOINT_MISSING');const distances=nodes.map(()=>Infinity),lengths=nodes.map(()=>Infinity),changes=nodes.map(()=>Infinity),previous=nodes.map(()=>null),done=new Set();for(const s of starts){distances[s]=0;lengths[s]=0;changes[s]=0;}let goal=null;
  while(done.size<nodes.length){if((done.size&63)===0)budget?.assertRemaining();let current=-1;for(let i=0;i<nodes.length;i++)if(!done.has(i)&&(current<0||distances[i]<distances[current]-EPS||Math.abs(distances[i]-distances[current])<=EPS&&changes[i]<changes[current]))current=i;if(current<0||!Number.isFinite(distances[current]))break;done.add(current);if(goals.has(current)){goal=current;break;}for(const e of adj[current]){const width=e.kind==='trace'?wires[e.reference].width:normalWidthMil,d=distances[current]+(preferWide?e.length/width:e.length),c=changes[current]+e.changes;if(d<distances[e.to]-EPS||Math.abs(d-distances[e.to])<=EPS&&c<changes[e.to]){distances[e.to]=d;lengths[e.to]=lengths[current]+e.length;changes[e.to]=c;previous[e.to]={node:current,edge:e};}}}
  if(goal===null)return{net,connected:false,projectionLengthMm:null};const ids=[goal],edges=[];for(let at=goal;previous[at];){edges.push(previous[at].edge);at=previous[at].node;ids.push(at);}ids.reverse();edges.reverse();const terms={trace:0,pad:0,contact:0};for(const e of edges)terms[e.kind==='trace'?'trace':e.kind==='pad-copper'?'pad':'contact']+=e.length;
  return{net,connected:true,projectionLengthMm:lengths[goal]*MIL,selectionMetric:preferWide?'trace-length/width proxy':'projected centreline length',selectionCost:distances[goal],traceCentrelineMm:terms.trace*MIL,padTransferMm:terms.pad*MIL,contactTransferMm:terms.contact*MIL,layerChanges:changes[goal],viasUsed:[...new Set(edges.filter(e=>e.kind==='via-layer').map(e=>e.reference))],points:ids.map(id=>nodes[id]),edges:edges.map(e=>({kind:e.kind,lengthMm:e.length*MIL,reference:e.reference})),scope:'XY copper-centreline estimate including pad/contact transfers; vertical barrels and physical current distribution excluded'};
 }
 budget?.assertRemaining();return{shortest,nodeCount:nodes.length,net};
}
export function hullAreaMm2(points){
 const p=[...new Map(points.map(p=>[[p.x,p.y].join(','),[p.x,p.y]])).values()].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);if(p.length<3)return 0;const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]),lower=[],upper=[];for(const q of p){while(lower.length>1&&cross(lower.at(-2),lower.at(-1),q)<=0)lower.pop();lower.push(q);}for(const q of [...p].reverse()){while(upper.length>1&&cross(upper.at(-2),upper.at(-1),q)<=0)upper.pop();upper.push(q);}const hull=[...lower.slice(0,-1),...upper.slice(0,-1)];return Math.abs(hull.reduce((n,p,i)=>n+p[0]*hull[(i+1)%hull.length][1]-p[1]*hull[(i+1)%hull.length][0],0))/2*MIL*MIL;
}

function resolveEndpoint(board, endpoint, net, id) {
 const matches=board.pads.filter(p=>typeof endpoint==='string'?p.id===endpoint||p.ref+'.'+p.pin===endpoint:endpoint?.padId?p.id===endpoint.padId:p.ref===endpoint?.ref&&String(p.pin)===String(endpoint?.pin));
 if(matches.length!==1||matches[0].net!==net)throw Error('CRITICAL_PATH_ENDPOINT:'+id);
 return matches[0];
}
export function criticalRouteMetrics(board,{pairs:definitions,groups=[],budget}={}){
 if(!Array.isArray(definitions)||!definitions.length)throw Error('CRITICAL_PATH_DEFINITIONS_REQUIRED');
 const graphs=new Map(),ids=new Set(),pairs=[];
 for(const definition of definitions){
  const {id,net,from,to,preferWide=false,normalWidthMil}=definition;
  if(!id||!net||ids.has(id))throw Error('UNIQUE_CRITICAL_PATH_ID_REQUIRED');ids.add(id);
  const start=resolveEndpoint(board,from,net,id),end=resolveEndpoint(board,to,net,id);
  if(!graphs.has(net))graphs.set(net,createCopperPathGraph(board,net,{budget}));
  const graph=graphs.get(net),path=graph.shortest(start.id,end.id),widePath=preferWide?graph.shortest(start.id,end.id,{preferWide,normalWidthMil}):null;
  const straightMm=Math.hypot(start.x-end.x,start.y-end.y)*MIL,scored=widePath??path;
  pairs.push({id,net,endpoints:[from,to],straightMm,...path,widePreferredPath:widePath,scoredPathMm:scored.projectionLengthMm,stretch:path.connected&&straightMm>0?path.projectionLengthMm/straightMm:null});
 }
 const grouped=groups.map(group=>{
  if(!group.id||!Array.isArray(group.pairIds)||!group.pairIds.length||group.pairIds.some(id=>!ids.has(id)))throw Error('INVALID_PATH_GROUP');
  const paths=group.pairIds.map(id=>pairs.find(p=>p.id===id)),connected=paths.every(p=>p.connected);
  return{id:group.id,pairIds:[...group.pairIds],connected,externalProjectedPathMm:connected?paths.reduce((sum,p)=>sum+p.projectionLengthMm,0):null,projectedRouteHullAreaMm2:connected?hullAreaMm2(paths.flatMap(p=>p.points)):null,scope:'External route envelope only; internal device paths and electromagnetic loop not modelled'};
 });
 return{pairs,groups:grouped,groundReturnClosed:false,thermalVerified:false,emiVerified:false,metricVersion:'copper-centreline-projection-v2',scope:'Offline copper projection metrics only'};
}
export function runCopperPaths({board,metrics,budget}){return{readOnly:true,...criticalRouteMetrics(board,{...metrics,budget})};}
