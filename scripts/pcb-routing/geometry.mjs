const eps=0.08;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function pointSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;return dist(p,[a[0]+t*dx,a[1]+t*dy]);}
function cross(a,b,c){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function segmentDistance(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);if(x*y<0&&z*w<0)return 0;return Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));}
function inside(p,poly){let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;}return result;}
function edges(poly){return poly.map((p,i)=>[p,poly[(i+1)%poly.length]]);}
function separation(a,b){
 if(a.kind==='polygon'&&b.kind!=='polygon')return separation(b,a);
 if(a.kind==='polygon'){
  if(a.points.some(p=>inside(p,b.points))||b.points.some(p=>inside(p,a.points)))return 0;
  return Math.min(...edges(a.points).flatMap(([p,q])=>edges(b.points).map(([r,s])=>segmentDistance(p,q,r,s))));
 }
 const aa=a.a??a.center,ab=a.b??aa,ar=a.radius??0;
 if(b.kind==='polygon'){
  if(inside(aa,b.points)||inside(ab,b.points))return -ar;
  return Math.min(...edges(b.points).map(([p,q])=>segmentDistance(aa,ab,p,q)))-ar;
 }
 const ba=b.a??b.center,bb=b.b??ba;return segmentDistance(aa,ab,ba,bb)-ar-(b.radius??0);
}
export function conductiveGap(a,b){return a.layers.some(l=>b.layers.includes(l))?separation(a,b):Infinity;}
export function conductiveContact(a,b){return conductiveGap(a,b)<=eps;}

export function routingLayers(layers,name='BOARD_LAYERS'){
 if(!Array.isArray(layers)||!layers.length||layers.some(l=>!Number.isInteger(l)||l<=0)||new Set(layers).size!==layers.length)throw Error('INVALID_'+name);
 return layers;
}
/** Explicit via spans win. An explicit board inventory is a historical through-via default only. */
export function routingViaLayers(v,boardLayers){
 const layers=v.layers??boardLayers;
 if(layers===undefined)throw Error('UNKNOWN_VIA_LAYERS:'+String(v.id??''));
 routingLayers(layers,'VIA_LAYERS');
 if(boardLayers!==undefined){routingLayers(boardLayers);if(layers.some(l=>!boardLayers.includes(l)))throw Error('VIA_LAYER_OUTSIDE_BOARD:'+String(v.id??''));}
 return layers;
}
function connectivityObjects(net,pads,segments,vias,{layers}={}){
 if(layers!==undefined)routingLayers(layers);
 const objects=[];
 const check=shapes=>{for(const shape of shapes){routingLayers(shape.layers,'COPPER_LAYERS');if(layers&&shape.layers.some(l=>!layers.includes(l)))throw Error('COPPER_LAYER_OUTSIDE_BOARD');}return shapes;};
 for(const p of pads.filter(p=>p.net===net))objects.push({role:'pad',id:p.id,sourceId:p.id,shapes:check(p.contactShapes??p.shapes)});
 for(const [i,s]of segments.filter(s=>s.net===net).entries())objects.push({role:'wire',id:'wire'+i,sourceId:s.id??'wire'+i,shapes:check([{kind:'capsule',a:[s.x1,s.y1],b:[s.x2,s.y2],radius:s.width/2,layers:[s.layer]}])});
 for(const [i,v]of vias.filter(v=>v.net===net).entries())objects.push({role:'via',id:'via'+i,sourceId:v.id??'via'+i,assumedThrough:v.layers===undefined,shapes:[{kind:'circle',center:[v.x,v.y],radius:v.diameter/2,layers:routingViaLayers(v,layers)}]});
 return objects;
}
function contactGraph(objects){
 const graph=objects.map(()=>[]);for(let i=0;i<objects.length;i++)for(let j=i+1;j<objects.length;j++)if(objects[i].shapes.some(a=>objects[j].shapes.some(b=>conductiveContact(a,b)))){graph[i].push(j);graph[j].push(i);}
 return graph;
}
export function connectivityIslands(net,pads,segments,vias,options={}){
 const objects=connectivityObjects(net,pads,segments,vias,options),graph=contactGraph(objects),seen=new Set(),islands=[];
 for(let i=0;i<objects.length;i++)if(!seen.has(i)){
  const island={pads:[],wires:[],vias:[]},queue=[i];seen.add(i);
  while(queue.length){const k=queue.shift(),object=objects[k];island[object.role==='pad'?'pads':object.role==='wire'?'wires':'vias'].push(object.sourceId);for(const j of graph[k])if(!seen.has(j)){seen.add(j);queue.push(j);}}
  islands.push(island);
 }
 return islands;
}
export function checkConnectivity(net,pads,segments,vias,options={}){
 const selectedPads=pads.filter(p=>p.net===net);
 if(selectedPads.length<2)throw Error('NET_REQUIRES_MULTIPLE_PADS:'+net);
 const objects=connectivityObjects(net,pads,segments,vias,options),graph=contactGraph(objects);
 const seen=new Set([0]),queue=[0];while(queue.length)for(const j of graph[queue.shift()])if(!seen.has(j)){seen.add(j);queue.push(j);}
 const disconnected=objects.filter((o,i)=>!seen.has(i));
 return{net,padCount:selectedPads.length,wireCount:objects.filter(o=>o.role==='wire').length,viaCount:objects.filter(o=>o.role==='via').length,connected:disconnected.length===0,disconnected:disconnected.map(o=>({role:o.role,id:o.id})),assumedThroughViaIds:objects.filter(o=>o.assumedThrough).map(o=>o.sourceId)};
}

export function terminalIntervals(s,shape){
 const a=[s.x1,s.y1],v=[s.x2-s.x1,s.y2-s.y1],den=v[0]*v[0]+v[1]*v[1];if(!den)return [];
 if(shape.kind==='circle'){
  const d=[a[0]-shape.center[0],a[1]-shape.center[1]],b=2*(d[0]*v[0]+d[1]*v[1]),c=d[0]*d[0]+d[1]*d[1]-shape.radius*shape.radius,disc=b*b-4*den*c;
  if(disc<0)return [];const lo=Math.max(0,(-b-Math.sqrt(disc))/(2*den)),hi=Math.min(1,(-b+Math.sqrt(disc))/(2*den));return lo<=hi?[[lo,hi]]:[];
 }
 const cuts=[0,1];for(const [p,q]of edges(shape.points)){
  const e=[q[0]-p[0],q[1]-p[1]],r=[p[0]-a[0],p[1]-a[1]],crossDen=v[0]*e[1]-v[1]*e[0];if(Math.abs(crossDen)<1e-12)continue;
  const t=(r[0]*e[1]-r[1]*e[0])/crossDen,u=(r[0]*v[1]-r[1]*v[0])/crossDen;if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);
 }
 cuts.sort((x,y)=>x-y);const result=[];for(let i=1;i<cuts.length;i++){
  const lo=cuts[i-1],hi=cuts[i],t=(lo+hi)/2,p=[a[0]+v[0]*t,a[1]+v[1]*t];
  if(inside(p,shape.points)||edges(shape.points).some(([x,y])=>pointSegment(p,x,y)<1e-9))result.push([lo,hi]);
 }return result;
}
export function traceCovered(s,rows,pads=[],vias=[],{layers}={}){
  const dx=s.x2-s.x1,dy=s.y2-s.y1,len=Math.hypot(dx,dy),eps=0.12;if(!len)return false;
  const intervals=[];for(const r of rows){if(r.net!==s.net||r.layer!==s.layer||Math.abs(r.width-s.width)>0.02)continue;const a=[r.x1-s.x1,r.y1-s.y1],b=[r.x2-s.x1,r.y2-s.y1];if(Math.abs(a[0]*dy-a[1]*dx)/len>eps||Math.abs(b[0]*dy-b[1]*dx)/len>eps)continue;const x=(a[0]*dx+a[1]*dy)/len,y=(b[0]*dx+b[1]*dy)/len,lo=Math.max(0,Math.min(x,y)),hi=Math.min(len,Math.max(x,y));if(lo<=hi)intervals.push([lo,hi]);}
  // Terminal copper has separate pad/drill rules. Omitting a redundant
  // centreline within a stable terminal does not remove its connection.
  const terminals=[...pads.filter(p=>p.net===s.net).flatMap(p=>p.shapes.filter(g=>g.layers.includes(s.layer))),...vias.filter(v=>v.net===s.net&&routingViaLayers(v,layers).includes(s.layer)).map(v=>({kind:'circle',center:[v.x,v.y],radius:v.diameter/2}))];
  for(const shape of terminals)for(const [lo,hi]of terminalIntervals(s,shape))intervals.push([lo*len,hi*len]);
  intervals.sort((a,b)=>a[0]-b[0]);let end=0;for(const [lo,hi]of intervals){if(lo>end+eps)return false;end=Math.max(end,hi);}return end>=len-eps;
 };

export function verifyRealization({expected,actual,pads=[],layers}) {
 if(layers!==undefined)routingLayers(layers);
 const missing=expected.segments.filter(s=>!traceCovered(s,actual.segments,pads,actual.vias,{layers}));
 const unexpected=actual.segments.filter(s=>!traceCovered(s,expected.segments,pads,expected.vias,{layers}));
 const viaLayers=v=>routingViaLayers(v,layers).slice().sort((a,b)=>a-b).join(',');
 const sameVia=(a,b)=>a.net===b.net&&viaLayers(a)===viaLayers(b)&&Math.hypot(a.x-b.x,a.y-b.y)<.12&&Math.abs(a.diameter-b.diameter)<.02&&Math.abs(a.hole-b.hole)<.02;
 const unmatched=actual.vias.slice();let viaMismatch=false;for(const v of expected.vias){const i=unmatched.findIndex(a=>sameVia(a,v));if(i<0)viaMismatch=true;else unmatched.splice(i,1);}
 return {passed:!missing.length&&!unexpected.length&&!viaMismatch&&!unmatched.length,missing,unexpected,viaMismatch:viaMismatch||!!unmatched.length,assumedThroughVias:{expected:expected.vias.filter(v=>v.layers===undefined).length,actual:actual.vias.filter(v=>v.layers===undefined).length}};
}
export function outsidePadSegments(s,pad,margin=0){
 const points=pad.shapes.flatMap(g=>g.points??[[g.center[0]-g.radius,g.center[1]-g.radius],[g.center[0]+g.radius,g.center[1]+g.radius]]);
 const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x0=Math.min(...xs)-margin,x1=Math.max(...xs)+margin,y0=Math.min(...ys)-margin,y1=Math.max(...ys)+margin;
 const clipped=terminalIntervals(s,{kind:'polygon',points:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
 const keep=[];let end=0;for(const [a,b]of clipped){if(a>end)keep.push([end,a]);end=Math.max(end,b);}if(end<1)keep.push([end,1]);
 return keep.filter(([a,b])=>b-a>1e-8).map(([a,b])=>({...s,x1:s.x1+(s.x2-s.x1)*a,y1:s.y1+(s.y2-s.y1)*a,x2:s.x1+(s.x2-s.x1)*b,y2:s.y1+(s.y2-s.y1)*b}));
}
export function pointInsidePad(point,pad,margin=0){return pad.shapes.some(g=>g.kind==='circle'?dist(point,g.center)<=g.radius-margin:inside(point,g.points)&&edges(g.points).every(([a,b])=>pointSegment(point,a,b)>=margin-1e-9));}
export function contactOutsidePad(s,oldShape,pad){
 if(!s.layer||!oldShape.layers.includes(s.layer))return false;
 // Exclude only the source pad interior. Remaining centreline contacts are
 // conservatively expanded by the new trace radius.
 for(const piece of outsidePadSegments(s,pad))if(conductiveGap({kind:'capsule',a:[piece.x1,piece.y1],b:[piece.x2,piece.y2],radius:piece.width/2,layers:[piece.layer]},oldShape)<=.08)return true;
 return false;
}
