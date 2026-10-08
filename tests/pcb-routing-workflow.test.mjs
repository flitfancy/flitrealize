import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseSpecctra,child,children} from '../scripts/pcb-routing/specctra.mjs';
import {runWorkflow} from '../scripts/pcb-routing/workflow.mjs';
function fixture(){
 const pads=[['A','P',0,0],['B','P',30,0],['C','P',15,30],['D','Q',70,0],['E','Q',100,0]].map(([id,net,x,y])=>({id,net,x,y,image:'u1',dsnRef:'u1-'+id,shapes:[{kind:'circle',center:[x,y],radius:2,layers:[1,16]}]}));
 const ast=parseSpecctra('(PCB demo (structure (layer TopLayer (type signal)) (layer Inner1 (type signal)) (layer Inner2 (type signal)) (layer BottomLayer (type signal)) (via v)) (library (image u1 (pin p A 0 0) (pin p B 30 0) (pin p C 15 30) (pin p D 70 0) (pin p E 100 0)) (padstack p (shape (circle TopLayer 4)))) (placement (component u1 (place u1 0 0 front 0))) (network (net P (pins u1-A u1-B u1-C)) (net Q (pins u1-D u1-E)) (class P P (rule (width 20))) (class Q Q (rule (width 6)))) (wiring))');
 const line={PrimitiveId:'old',Net:'P',Layer:16,LineWidth:20,StartX:0,StartY:0,EndX:30,EndY:0};
 const board={target:{project:'PROJECT',document:'PCB'},ast,pads,segments:[{id:'old',net:'P',layer:16,width:20,x1:0,y1:0,x2:30,y2:0}],vias:[],layerMap:{TopLayer:1,Inner1:15,Inner2:16,BottomLayer:2},layerNames:['TopLayer','Inner1','Inner2','BottomLayer'],layers:[1,15,16,2],native:{netNames:['P','Q'],objects:{lines:[line],vias:[],arcs:[],polylines:[],pours:[]},sourceInvariantHash:'S',footprintHash:'F'}};
 const policy={units:'mil',clearances:{ordinaryCopperMil:6},nets:[{net:'P',priority:1,primaryAutoLayers:[1,16],defaultWireWidthMil:20,via:{diameterMil:24,holeMil:12,minParallelLoadVias:1},endpoints:[{endpoint:'U.1',padId:'A'},{endpoint:'J.1',padId:'B'},{endpoint:'R.1',padId:'C'}],roles:[{name:'load_current_main',endpoints:['U.1','J.1'],allowedLayers:[1,16],viaTransition:{sourceLayer:1,targetLayer:16},widthMil:20},{name:'low_current_branch',endpoints:['R.1'],allowedLayers:[1,2],widthMil:6}]},{net:'Q',priority:2,primaryAutoLayers:[1],defaultWireWidthMil:6,endpoints:[{endpoint:'X.1',padId:'D'},{endpoint:'Y.1',padId:'E'}],roles:[{name:'signal',endpoints:['X.1','Y.1'],allowedLayers:[1],widthMil:6}]}]};
 return{board,policy,line};
}
async function route(_runtime,files){
 assert.ok(files.ignoredClasses.includes('default'));
 assert.ok(!files.ignoredClasses.includes('FLIT_TASK'));
 const ast=parseSpecctra(await fs.readFile(files.input,'utf8')),c=children(child(ast,'network'),'class').find(c=>c[1]==='FLIT_TASK'),net=c[2];
 const content=net==='P'?'': '(net Q (wire (path TopLayer 6000 70000 0 100000 0)))';
 await fs.writeFile(files.output,'(session demo (routes (resolution mil 1000) (network_out '+content+')))');return{seconds:.001};
}
test('a blocked candidate is recorded and the next independent task still runs',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'flit-routing-')),f=fixture();
 try{const r=await runWorkflow({...f,directory,runtime:{},route});assert.equal(r.saved,false);assert.equal(r.status,'candidate-ready');assert.equal(r.counts.blocked,1);assert.equal(r.counts.candidates,1);assert.equal(r.counts.connectedExisting,1);assert.deepEqual(f.board.segments.map(s=>s.id),['old']);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('only qualified candidates reach native apply and a batch saves once',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'flit-routing-')),f=fixture(),calls=[];
 const after={sourceInvariantHash:'S',footprintHash:'F',objects:{...f.board.native.objects,lines:[f.line,{PrimitiveId:'new',Net:'Q',Layer:1,LineWidth:6,StartX:70,StartY:0,EndX:100,EndY:0}]},counts:{lines:2,vias:0}};
 try{const native=async req=>{calls.push(req.mode);if(req.mode==='apply'){assert.deepEqual(req.input.selectedNets,['Q']);return{status:'applied-verified-unsaved',...after};}if(req.mode==='save')return{status:'saved',saved:true,...after};return{status:'inspected',...after};};const r=await runWorkflow({...f,directory,runtime:{},route,native,apply:true,windowId:'WINDOW'});assert.equal(r.status,'saved-with-blocked-tasks');assert.equal(r.saved,true);assert.deepEqual(calls,['apply','save','inspect']);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('unknown native outcomes stop without save or replay',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'flit-routing-')),f=fixture(),calls=[];
 try{const native=async req=>{calls.push(req.mode);throw Error('NATIVE_REQUEST_UNRESOLVED');};const r=await runWorkflow({...f,directory,runtime:{},route,native,apply:true,windowId:'WINDOW'});assert.equal(r.status,'needs-attention');assert.equal(r.saved,false);assert.deepEqual(calls,['apply']);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
