import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {verifyRealization,checkConnectivity,connectivityIslands} from '../scripts/pcb-routing/geometry.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/pcb-routing/terminal-copper-realization.json',import.meta.url)));
fixture.layers=[1,15,16,2]; // Saved EasyEDA/FR fixture used through vias on this declared stack.
const wire=(x1,x2,width=6,layer=1,net='N')=>({net,layer,width,x1,y1:0,x2,y2:0});
test('terminal copper can replace an omitted redundant trace',()=>assert.equal(verifyRealization(fixture).passed,true));
test('splitting and merging collinear traces preserve routing intent',()=>{
 assert.equal(verifyRealization({expected:{segments:[wire(0,30)],vias:[]},actual:{segments:[wire(0,10),wire(10,20),wire(20,30)],vias:[]},pads:[]}).passed,true);
 assert.equal(verifyRealization({expected:{segments:[wire(0,10),wire(10,30)],vias:[]},actual:{segments:[wire(0,30)],vias:[]},pads:[]}).passed,true);
});
test('a genuine gap, narrowing, wrong layer, or wrong net fails',()=>{
 for(const segments of [[wire(0,10),wire(11,30)],[wire(0,30,5)],[wire(0,30,6,2)],[wire(0,30,6,1,'OTHER')]])assert.equal(verifyRealization({expected:{segments:[wire(0,30)],vias:[]},actual:{segments,vias:[]},pads:[]}).passed,false);
});
test('unplanned copper and changed drill geometry fail',()=>{
 assert.equal(verifyRealization({expected:{segments:[wire(0,10)],vias:[]},actual:{segments:[wire(0,15)],vias:[]},pads:[]}).passed,false);
 const altered=structuredClone(fixture);altered.actual.vias[0].hole+=2;assert.equal(verifyRealization(altered).passed,false);
});
test('other-net terminal copper cannot hide missing traces',()=>{
 const pad={net:'OTHER',shapes:[{kind:'polygon',points:[[-1,-10],[40,-10],[40,10],[-1,10]],layers:[1]}]};
 assert.equal(verifyRealization({expected:{segments:[wire(0,30)],vias:[]},actual:{segments:[],vias:[]},pads:[pad]}).passed,false);
});
test('terminal acceptance is independent of board coordinates, orientation, names, and segment count',()=>{
 for(let i=0;i<32;i++){
  const f=structuredClone(fixture),angle=i*Math.PI/16,tx=137*i,ty=-83*i;
  const transform=([x,y])=>[x*Math.cos(angle)-y*Math.sin(angle)+tx,x*Math.sin(angle)+y*Math.cos(angle)+ty];
  for(const state of [f.expected,f.actual]){
   state.segments=state.segments.flatMap((s,j)=>{
    const [x1,y1]=transform([s.x1,s.y1]),[x2,y2]=transform([s.x2,s.y2]);
    const renamed={...s,net:'renamed_'+i,x1,y1,x2,y2};
    if(j%3)return[renamed];
    const xm=(x1+x2)/2,ym=(y1+y2)/2;
    return[{...renamed,x2:xm,y2:ym},{...renamed,x1:xm,y1:ym}];
   });
   for(const v of state.vias){[v.x,v.y]=transform([v.x,v.y]);v.net='renamed_'+i;}
   state.vias.reverse();
  }
  for(const p of f.pads){p.net='renamed_'+i;for(const g of p.shapes)if(g.points)g.points=g.points.map(transform);else g.center=transform(g.center);}
  assert.equal(verifyRealization(f).passed,true,'transformed case '+i);
 }
});
test('terminal copper cannot conceal a gap between pads or a terminal on the wrong layer',()=>{
 const pad=(net,layer,x0,x1)=>({net,shapes:[{kind:'polygon',points:[[x0,-5],[x1,-5],[x1,5],[x0,5]],layers:[layer]}]});
 const f={expected:{segments:[wire(0,30)],vias:[]},actual:{segments:[],vias:[]}};
 assert.equal(verifyRealization({...f,pads:[pad('N',1,-5,10),pad('N',1,11,35)]}).passed,false);
 assert.equal(verifyRealization({...f,pads:[pad('N',2,-5,35)]}).passed,false);
});
test('declared via span, explicit through default and unknown layers have one connectivity contract',()=>{
 const pads=[1,2].map((layer,i)=>({id:'pad'+i,net:'N',shapes:[{kind:'circle',center:[0,0],radius:5,layers:[layer]}]}));
 const via={id:'via',net:'N',x:0,y:0,diameter:10,hole:4,layers:[1]};
 assert.equal(checkConnectivity('N',pads,[],[via],{layers:[1,2]}).connected,false);
 assert.equal(connectivityIslands('N',pads,[],[via],{layers:[1,2]}).length,2);
 via.layers=[1,2];assert.equal(checkConnectivity('N',pads,[],[via],{layers:[1,2]}).connected,true);
 delete via.layers;assert.throws(()=>checkConnectivity('N',pads,[],[via]),/UNKNOWN_VIA_LAYERS/);
 const assumed=checkConnectivity('N',pads,[],[via],{layers:[1,2]});assert.equal(assumed.connected,true);assert.deepEqual(assumed.assumedThroughViaIds,['via']);
 via.layers=[1,99];assert.throws(()=>checkConnectivity('N',pads,[],[via],{layers:[1,2]}),/VIA_LAYER_OUTSIDE_BOARD/);
});
