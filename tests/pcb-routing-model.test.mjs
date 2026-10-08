import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTasks,buildTaskDsn,decodeSes,overlayBoard,taskConnectivity,validateCandidate} from '../scripts/pcb-routing/model.mjs';
import {parseSpecctra,child,children} from '../scripts/pcb-routing/specctra.mjs';
function fixture(){
 const pad=(id,x,y)=>({id,net:'P',x,y,dsnRef:'u1-'+id,image:'u1',shapes:[{kind:'circle',center:[x,y],radius:2,layers:[1,16]}]});
 const pads=[pad('A',0,0),pad('B',30,0),pad('C',15,30)];
 const board={ast:parseSpecctra('(PCB demo (structure (layer TopLayer (type signal)) (layer Inner1 (type signal)) (layer Inner2 (type signal)) (layer BottomLayer (type signal)) (via v)) (library (image u1 (pin p A 0 0) (pin p B 30 0) (pin p C 15 30)) (padstack p (shape (circle TopLayer 4)))) (placement (component u1 (place u1 0 0 front 0))) (network (net P (pins u1-A u1-B u1-C)) (class P P (rule (width 20)))) (wiring))'),pads,segments:[{net:'P',layer:16,width:20,x1:0,y1:0,x2:30,y2:0}],vias:[],layerMap:{TopLayer:1,Inner1:15,Inner2:16,BottomLayer:2},layerNames:['TopLayer','Inner1','Inner2','BottomLayer'],layers:[1,15,16,2],native:{netNames:['P']}};
 const policy={units:'mil',layers:[{id:1},{id:15,signalRoutingAllowed:false},{id:16},{id:2}],clearances:{ordinaryCopperMil:6},nets:[{net:'P',priority:1,defaultWireWidthMil:20,primaryAutoLayers:[1,16],via:{holeMil:12,diameterMil:24,minParallelLoadVias:1},endpoints:[{endpoint:'U.1',padId:'A'},{endpoint:'J.1',padId:'B'},{endpoint:'R.1',padId:'C'}],roles:[{name:'load_current_main',endpoints:['U.1','J.1'],allowedLayers:[1,16],viaTransition:{sourceLayer:1,targetLayer:16},widthMil:20},{name:'low_current_branch',endpoints:['R.1'],allowedLayers:[1,2],widthMil:6}]}]};return{board,policy};
}

function customLayers(){
 const f=fixture(),mapping={1:7,15:42,16:33,2:9};
 f.board.layers=f.board.layers.map(layer=>mapping[layer]);for(const [name,layer]of Object.entries(f.board.layerMap))f.board.layerMap[name]=mapping[layer];
 for(const pad of f.board.pads)for(const shape of pad.shapes)shape.layers=shape.layers.map(layer=>mapping[layer]);
 for(const segment of f.board.segments)segment.layer=mapping[segment.layer];
 f.policy.layers=f.policy.layers.map(layer=>({...layer,id:mapping[layer.id]}));
 for(const net of f.policy.nets){net.primaryAutoLayers=net.primaryAutoLayers.map(layer=>mapping[layer]);for(const role of net.roles){role.allowedLayers=role.allowedLayers.map(layer=>mapping[layer]);if(role.viaTransition)role.viaTransition={sourceLayer:mapping[role.viaTransition.sourceLayer],targetLayer:mapping[role.viaTransition.targetLayer]};}}
 return f;
}
test('an existing main conductor is retained while compiling its next branch',()=>{
 const {board,policy}=fixture(),tasks=compileTasks(board,policy);assert.equal(tasks[0].status,'already-connected');assert.equal(tasks[1].status,'pending');assert.deepEqual(tasks[1].requiredPadIds.sort(),['A','B','C']);
 const input=buildTaskDsn(board,tasks[1],policy),ast=parseSpecctra(input.dsn),wire=child(ast,'wiring')[1];assert.equal(child(wire,'type')[1],'fix');assert.equal(child(wire,'path')[2],'20');assert.ok(input.dsn.includes('width 6'));assert.ok(input.dsn.includes('use_layer TopLayer BottomLayer'));
});
test('Kelvin tasks use a dedicated pickup and reject contact with load copper outside the source pad',()=>{
 const {board,policy}=fixture();board.pads[0].shapes=[{kind:'polygon',points:[[-20,-20],[20,-20],[20,20],[-20,20]],layers:[1]}];board.segments[0].layer=1;
 policy.nets[0].roles=[{name:'kelvin_sense',endpoints:['U.1','R.1'],junctionEndpoint:'U.1',destination:'R.1',pickup:{xMil:0,yMil:0,layer:1},allowedLayers:[1],widthMil:6}];
 const task=compileTasks(board,policy)[0],input=buildTaskDsn(board,task,policy),ast=parseSpecctra(input.dsn);
 const sourcePin=children(children(child(ast,'library'),'image')[0],'pin').find(p=>p[2]==='A');assert.equal(sourcePin[1],'FLIT_KELVIN_PICKUP');
 assert.equal(children(child(ast,'wiring'),'wire').length,0);
 assert.ok(!input.dsn.includes('FLIT_LOAD_EXISTING'));
 const wire=(x1,y1,x2,y2)=>({net:'P',layer:1,width:6,x1,y1,x2,y2});
 const good=validateCandidate(board,task,{segments:[wire(0,0,15,30)],vias:[]},input);assert.equal(good.passed,true);
 const bad=validateCandidate(board,task,{segments:[wire(0,0,30,0),wire(30,0,15,30)],vias:[]},input);assert.ok(bad.issues.some(i=>i.code==='KELVIN_REATTACHED_OUTSIDE_SHUNT'));
});
test('an overlay updates connection state without claiming an EDA save',()=>{
 const {board,policy}=fixture(),task=compileTasks(board,policy)[1],next=overlayBoard(board,{segments:[{net:'P',layer:1,width:6,x1:0,y1:0,x2:15,y2:30}],vias:[]});assert.equal(taskConnectivity(next,task).connected,true);assert.equal(taskConnectivity(board,task).connected,false);
});
test('unknown endpoints, reference-ground routing, and locked rework are rejected',()=>{
 const {board,policy}=fixture();const bad=structuredClone(policy);bad.nets[0].roles[1].endpoints=['MISSING'];assert.throws(()=>compileTasks(board,bad),/ROLE_ENDPOINT_MISSING/);
 const ground=structuredClone(policy);ground.nets[0].roles[1].allowedLayers=[15];assert.throws(()=>compileTasks(board,ground),/RESERVED_AUTO_ROUTING_LAYER/);
 board.segments[0].locked=true;assert.throws(()=>buildTaskDsn(board,compileTasks(board,policy)[1],policy,{reworkNets:['P']}),/LOCKED_REWORK_NET/);
});

test('ordinary inner signal routing follows declarations instead of treating layer 15 as ground',()=>{
 const {board,policy}=fixture();delete policy.layers;policy.nets[0].roles[1].allowedLayers=[15];
 const task=compileTasks(board,policy)[1];assert.deepEqual(task.layers,[15]);assert.ok(task.layerPolicy.diagnostics.some(issue=>issue.code==='LEGACY_LAYER_PERMISSIONS_UNDECLARED'));
 policy.layers=[{id:15,signalRoutingAllowed:false}];assert.throws(()=>compileTasks(board,policy),/RESERVED_AUTO_ROUTING_LAYER/);
});

test('multilayer main roles refuse missing transition or parallel-count declarations',()=>{
 const {board,policy}=fixture();delete policy.nets[0].roles[0].viaTransition;
 assert.throws(()=>compileTasks(board,policy),/LOAD_VIA_TRANSITION_RULE_REQUIRED/);
 policy.nets[0].roles[0].viaTransition={sourceLayer:1,targetLayer:16};delete policy.nets[0].via.minParallelLoadVias;
 assert.throws(()=>compileTasks(board,policy),/LOAD_PARALLEL_VIA_COUNT_REQUIRED/);
});

test('load escape and target bridge seeds use arbitrary declared source and target IDs',()=>{
 const {board,policy}=customLayers(),task=compileTasks(board,policy)[0];
 const input=buildTaskDsn(board,task,policy,{escapes:{seeds:[{net:'P',padId:'A',offsetMil:[0,30],widthMil:6},{net:'P',padId:'A',offsetMil:[0,-30],widthMil:6}]}});
 assert.deepEqual(task.viaTransition,{sourceLayer:7,targetLayer:33,minParallelVias:1,source:'role.viaTransition + net.via.minParallelLoadVias'});
 assert.equal(input.seedSegments.filter(segment=>segment.layer===7).length,2);assert.equal(input.seedSegments.filter(segment=>segment.layer===33).length,1);
 assert.ok(!input.seedSegments.some(segment=>[1,16].includes(segment.layer)));
});

test('parallel via acceptance uses declared IDs and does not force a legal all-source-layer route to transition',()=>{
 const {board,policy}=customLayers();policy.nets[0].via.minParallelLoadVias=2;
 for(const pad of board.pads){pad.shapes[0].layers=[7];if(pad.id==='C'){pad.x=200;pad.y=200;pad.shapes[0].center=[200,200];}}
 board.segments=[];const task=compileTasks(board,policy)[0],input=buildTaskDsn(board,task,policy),wire=(x1,y1,x2,y2)=>({net:'P',layer:7,width:20,x1,y1,x2,y2});
 assert.equal(validateCandidate(board,task,{segments:[wire(0,0,30,0)],vias:[]},input).passed,true);
 board.segments=[{net:'P',layer:33,width:20,x1:-30,y1:60,x2:60,y2:60}];
 const via=x=>({net:'P',x,y:60,diameter:24,hole:12,layers:board.layers});
 const sparse={segments:[wire(0,0,0,60),wire(30,0,30,60)],vias:[via(0),via(30)]};
 const failed=validateCandidate(board,task,sparse,input);assert.equal(failed.passed,false);assert.equal(failed.issues.filter(issue=>issue.code==='PARALLEL_LOAD_VIAS_REQUIRED').length,2);
 const parallel={segments:[...sparse.segments,wire(0,0,-30,60),wire(30,0,60,60)],vias:[...sparse.vias,via(-30),via(60)]};
 assert.equal(validateCandidate(board,task,parallel,input).passed,true);
 const legacy=structuredClone(task);delete legacy.viaTransition;
 assert.ok(validateCandidate(board,legacy,parallel,input).issues.some(issue=>issue.code==='LOAD_VIA_TRANSITION_RULE_REQUIRED'));
});
test('reviewed parallel transition vias receive a bridge on the declared inner layer',()=>{
 const {board,policy}=fixture(),task=compileTasks(board,policy)[0];
 const input=buildTaskDsn(board,task,policy,{escapes:{seeds:[{net:'P',padId:'A',offsetMil:[0,20],widthMil:6},{net:'P',padId:'A',offsetMil:[0,-20],widthMil:6}]}});
 assert.equal(input.seedVias.length,2);
 assert.ok(input.seedSegments.some(s=>s.layer===16&&s.width===20&&s.y1===20&&s.y2===-20));
});
test('candidate checks reject injected foreign nets and unreviewed via dimensions',()=>{
 const {board,policy}=fixture(),task=compileTasks(board,policy)[1],input=buildTaskDsn(board,task,policy);
 const validation=validateCandidate(board,task,{segments:[{net:'FOREIGN',layer:1,width:6,x1:0,y1:0,x2:15,y2:30}],vias:[{net:'P',x:60,y:60,hole:10,diameter:20,layers:board.layers}]},input);
 assert.ok(validation.issues.some(i=>i.code==='UNREVIEWED_NET'));
 assert.ok(validation.issues.some(i=>i.code==='UNREVIEWED_VIA'));
});
test('the router receives an explicit ignore list for every class outside its selected scope',()=>{
 const {board,policy}=fixture();
 child(board.ast,'network').push(['class','OTHER_CLASS','OTHER',['rule',['width','6']]]);
 child(board.ast,'network').push(['class','','OTHER_EMPTY',['rule',['width','6']]]);
 const input=buildTaskDsn(board,compileTasks(board,policy)[1],policy);
 assert.ok(input.ignoredClasses.includes('OTHER_CLASS'));
 assert.ok(input.ignoredClasses.includes('default'));
 assert.ok(!input.ignoredClasses.includes('FLIT_TASK'));
 assert.equal(input.ignoredClasses[0],'');
});
test('unselected copper remains geometry obstacles without pins or traces that request routing',()=>{
 const {board,policy}=fixture();
 const pads=[70,100].map((x,i)=>({id:'Q'+i,net:'Q',x,y:0,dsnRef:'u1-Q'+i,image:'u1',shapes:[{kind:'circle',center:[x,0],radius:2,layers:[1]}]}));
 board.pads.push(...pads);board.segments.push(...pads.map(p=>({net:'Q',layer:1,width:6,x1:p.x,y1:0,x2:p.x+5,y2:0})));
 const library=child(board.ast,'library'),image=children(library,'image')[0];for(const p of pads)image.push(['pin','p',p.id,String(p.x),'0']);
 child(board.ast,'network').push(['net','Q',['pins','u1-Q0','u1-Q1']],['class','Q','Q',['rule',['width','6']]]);
 const task=compileTasks(board,policy,{nets:['P']})[1],input=buildTaskDsn(board,task,policy),ast=parseSpecctra(input.dsn),network=child(ast,'network');
 const aliases=Object.keys(input.aliases).filter(n=>input.aliases[n]==='Q');assert.equal(aliases.length,2);
 assert.equal(child(children(network,'net').find(n=>n[1]==='Q'),'pins').length,1);
 assert.ok(aliases.every(name=>child(children(network,'net').find(n=>n[1]===name),'pins').length===2));
 const wires=children(child(ast,'wiring'),'wire').filter(w=>aliases.includes(child(w,'net')[1]));assert.equal(wires.length,0);
 assert.equal(children(child(ast,'structure'),'keepout').length,2);
 assert.equal(board.segments.filter(s=>s.net==='Q').length,2);
});
test('fixed escape geometry echoed by SES is imported once and cannot double-count a load via',()=>{
 const {board,policy}=fixture(),task=compileTasks(board,policy)[0],input=buildTaskDsn(board,task,policy,{escapes:{seeds:[{net:'P',padId:'A',offsetMil:[0,20],widthMil:6}]}});
 const text='(session demo (routes (resolution mil 1000) (network_out (net P (wire (path TopLayer 6000 0 0 0 20000)) (via FLIT_VIA_24_12 0 20000)))))';
 const candidate=decodeSes(text,board,input);assert.equal(candidate.vias.length,1);assert.equal(candidate.segments.length,1);
});
test('staged inner transitions use a real full-width conductor for the temporary routing anchor',()=>{
 const {board,policy}=fixture();policy.nets[0].roles[0].localWidthMil=6;const task=compileTasks(board,policy)[0];
 const input=buildTaskDsn(board,task,policy,{escapes:{seeds:[{net:'P',padId:'A',offsetMil:[0,20],widthMil:6},{net:'P',padId:'A',offsetMil:[0,-20],widthMil:6}],transitionLayerWidthMil:{P:6},layerBridges:[{net:'P',padId:'A',layer:16,widthMil:6,fromOffsetMil:[0,20],toOffsetMil:[15,20]}],routingAnchors:[{net:'P',padId:'A',layer:16,widthMil:20,offsetMil:[15,20]}]}});
 assert.ok(input.seedSegments.some(s=>s.layer===16&&s.width===6));
 assert.ok(input.seedSegments.some(s=>s.layer===16&&s.width===20&&s.x1===13&&s.x2===17));
 assert.ok(input.dsn.includes('FLIT_ROUTING_ANCHOR_0'));assert.equal(input.seedVias.length,2);
 assert.throws(()=>buildTaskDsn(board,task,policy,{escapes:{transitionLayerWidthMil:{P:5}}}),/INVALID_LOCAL_TRANSITION/);
});
test('explicitly reworked copper is regenerated from real pads without old via or trace anchors',()=>{
 const {board,policy}=fixture();
 policy.nets.push({net:'Q',primaryAutoLayers:[1,2],defaultWireWidthMil:6,endpoints:[{endpoint:'X.1',padId:'D'},{endpoint:'Y.1',padId:'E'}],roles:[{name:'signal',endpoints:['X.1','Y.1'],allowedLayers:[1,2],widthMil:6}]});
 for(const [id,x]of [['D',70],['E',100]])board.pads.push({id,net:'Q',x,y:0,image:'u1',dsnRef:'u1-'+id,shapes:[{kind:'circle',center:[x,0],radius:2,layers:[1]}]});
 const image=children(child(board.ast,'library'),'image')[0];image.push(['pin','p','D','70','0'],['pin','p','E','100','0']);child(board.ast,'network').push(['net','Q',['pins','u1-D','u1-E']],['class','Q','Q']);
 board.vias.push({id:'q-via',net:'Q',x:85,y:10,diameter:24,hole:12,layers:board.layers});
 const input=buildTaskDsn(board,compileTasks(board,policy,{nets:['P']})[1],policy,{reworkNets:['Q']}),ast=parseSpecctra(input.dsn);
 assert.ok(!children(children(child(ast,'library'),'image')[0],'pin').some(p=>p[2]==='flit_existing_via_q-via'));
 assert.equal(children(child(ast,'wiring'),'via').length,0);
});
