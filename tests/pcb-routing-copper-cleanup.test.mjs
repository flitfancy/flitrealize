import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pruneCopper,bypassVias} from '../scripts/pcb-routing/copper-cleanup.mjs';
import {buildRouteConflictGraph,routingPlacementFingerprint,selectCompatibleRoutes} from '../scripts/pcb-routing/route-composition.mjs';
import {checkConnectivity} from '../scripts/pcb-routing/geometry.mjs';

const pad=(id,net,x,y,layers=[1])=>({id,net,x,y,shapes:[{kind:'polygon',points:[[x-5,y-5],[x+5,y-5],[x+5,y+5],[x-5,y+5]],layers}]});
const line=(id,net,layer,x1,y1,x2,y2)=>({id,net,layer,width:6,x1,y1,x2,y2});
const policy=net=>({units:'mil',clearances:{ordinaryCopperMil:6},nets:[{net,defaultWireWidthMil:6,roles:[{name:'ordinary_signal'}]}]});
test('ordinary pruning removes redundant copper, preserves all terminals and never changes the input',()=>{
 const board={layers:[1,2],pads:[pad('a','X',15,40),pad('b','X',105,40)],segments:[line('l1','X',1,15,40,105,40),line('l2','X',1,15,40,105,40)],vias:[{id:'v',net:'X',x:50,y:40,diameter:24,hole:12,layers:[1,2]}]};
 const original=structuredClone(board),out=pruneCopper(board,policy('X'),{nets:['X']});
 assert.deepEqual(board,original);assert.equal(out.board.vias.length,0);assert.equal(out.board.segments.length,1);assert.ok(checkConnectivity('X',out.board.pads,out.board.segments,out.board.vias).connected);
});
test('declared power roles and locked copper are preserved',()=>{
 const board={layers:[1,2],pads:[pad('a','POWER',15,40),pad('b','POWER',105,40)],segments:[line('l1','POWER',1,15,40,105,40)],vias:[{id:'v',net:'POWER',x:50,y:40,diameter:24,hole:12,layers:[1,2],locked:true}]};
 const p=policy('POWER');p.nets[0].roles=[{name:'load_current_main'}];const protectedResult=pruneCopper(board,p,{nets:['POWER']});assert.deepEqual(protectedResult.board,board);
 const lockedResult=pruneCopper(board,policy('POWER'),{nets:['POWER']});assert.equal(lockedResult.board.vias.length,1);
});
test('same-layer bypass removes a two-via excursion while keeping contacts',()=>{
 const board={layers:[1,2],bounds:{minX:0,minY:0,maxX:120,maxY:80},pads:[pad('a','X',15,40),pad('b','X',105,40)],segments:[line('a','X',1,15,40,40,40),line('b','X',2,40,40,80,40),line('c','X',1,80,40,105,40)],vias:[40,80].map((x,i)=>({id:'v'+i,net:'X',x,y:40,diameter:24,hole:12,layers:[1,2]}))};
 const result=bypassVias(board,policy('X'),{nets:['X'],viaCostMm:10,layerWeights:{1:1,2:4},copperEdgeMil:0});
 assert.ok(result.board.vias.length<2);assert.ok(checkConnectivity('X',result.board.pads,result.board.segments,result.board.vias).connected);
});
test('route graph records cross-layer alternatives and rejects changed pad geometry',()=>{
 const board={layers:[1,2],pads:[pad('s1','S',15,40),pad('s2','S',105,40),pad('t1','T',60,10,[1,2]),pad('t2','T',60,70,[1,2])],segments:[],vias:[]};
 const candidate=(layer)=>({segments:[line('s','S',1,15,40,105,40),line('t','T',layer,60,10,60,70)],vias:[]});
 const graph=buildRouteConflictGraph({board,trials:[{id:'top',board,candidate:candidate(1)},{id:'bottom',placementFingerprint:routingPlacementFingerprint(board),candidate:candidate(2)}],nets:['S','T'],clearanceMil:6,drillSpacingMil:18});
 assert.equal(graph.variants.length,3);assert.equal(graph.conflicts.length,1);
 const changed=structuredClone(board);changed.pads[0].x++;
 assert.throws(()=>buildRouteConflictGraph({board,trials:[{id:'bad',board:changed,candidate:candidate(1)}],nets:['S'],clearanceMil:6,drillSpacingMil:18}),/PLACEMENT_MISMATCH/);
});

test('composition and pruning use the same declared spans on non-native layer IDs',()=>{
 const board={layers:[3,7],pads:[pad('a','X',15,40,[3]),pad('b','X',105,40,[3])],segments:[],vias:[]};
 const segments=[line('left','X',3,15,40,40,40),line('bridge','X',7,40,40,80,40),line('right','X',3,80,40,105,40)];
 const vias=[40,80].map((x,i)=>({id:'v'+i,net:'X',x,y:40,diameter:24,hole:12,layers:[3,7]}));
 const connected={segments,vias},wrongSpan={segments,vias:vias.map(v=>({...v,layers:[3]}))};
 const graph=buildRouteConflictGraph({board,trials:[{id:'wrong-span',board,candidate:wrongSpan},{id:'connected',board,candidate:connected}],nets:['X'],clearanceMil:6,drillSpacingMil:18});
 assert.equal(graph.variants.length,1);assert.equal(graph.variants[0].trial,'connected');
 assert.equal(checkConnectivity('X',board.pads,segments,vias,{layers:board.layers}).connected,true);
 assert.throws(()=>pruneCopper({...board,...wrongSpan},policy('X'),{nets:['X']}),/CLEANUP_REQUIRES_CONNECTED_NET/);
 assert.doesNotThrow(()=>pruneCopper({...board,...connected},policy('X'),{nets:['X']}));
 const unknown={segments,vias:vias.map(v=>({...v,layers:[3,99]}))};
 assert.throws(()=>buildRouteConflictGraph({board,trials:[{id:'unknown',board,candidate:unknown}],nets:['X'],clearanceMil:6,drillSpacingMil:18}),/VIA_LAYER_OUTSIDE_BOARD/);
});

test('CP-SAT composes complete compatible routes and reports a forced conflict', {skip:!process.env.FLITREALIZE_CPSAT_PYTHON}, async()=>{
 const board={layers:[1,2],pads:[pad('s1','S',15,40),pad('s2','S',105,40),pad('t1','T',60,10,[1,2]),pad('t2','T',60,70,[1,2])],segments:[],vias:[]};
 const candidate=layer=>({segments:[line('s','S',1,15,40,105,40),line('t','T',layer,60,10,60,70)],vias:[]});
 const options={board,nets:['S','T'],clearanceMil:6,drillSpacingMil:18};
 const settings={forceNets:['S','T'],python:process.env.FLITREALIZE_CPSAT_PYTHON,maxSeconds:2,workers:1};
 const graph=buildRouteConflictGraph({...options,trials:[{id:'top',board,candidate:candidate(1)},{id:'bottom',board,candidate:candidate(2)}]});
 const result=await selectCompatibleRoutes(graph,settings);
 assert.equal(result.status,'OPTIMAL');assert.equal(result.connected,2);assert.equal(result.nativeWrites,0);
 assert.equal(result.candidate.segments.find(s=>s.net==='T').layer,2);
 for(const net of ['S','T'])assert.ok(checkConnectivity(net,board.pads,result.candidate.segments,result.candidate.vias).connected);
 const impossible=buildRouteConflictGraph({...options,trials:[{id:'top-only',board,candidate:candidate(1)}]});
 assert.equal((await selectCompatibleRoutes(impossible,settings)).status,'INFEASIBLE');
});
