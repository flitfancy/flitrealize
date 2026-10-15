import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {digest,prepareNativeSource} from '../../scripts/providers/easyeda-pro/routing-provider.mjs';
import {compileTasks} from '../../scripts/pcb-routing/model.mjs';

const directory=await fs.mkdtemp(join(tmpdir(),'routing-native-source-'));
let run;
try {
 const code=await fs.readFile(await prepareNativeSource(directory),'utf8');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 run=new AsyncFunction('eda','flitrealizeInput',code);
} finally {
 assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
 assert.ok(basename(directory).startsWith('routing-native-source-'));
 await fs.rm(directory,{recursive:true,force:true});
}
function fixture(){
 delete globalThis.__flitrealizeRoutingTransaction;
 const objects={lines:[],vias:[],arcs:[],polylines:[],pours:[]},calls={save:0,create:0,deleted:[]},source='';
 const fields=['PrimitiveId','Net','Layer','LineWidth','StartX','StartY','EndX','EndY','X','Y','Diameter','HoleDiameter','Rotation','PrimitiveLock'];
 const wrap=r=>Object.fromEntries(fields.map(k=>['getState_'+k,()=>r[k]??null]));
 const eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'D',documentType:3})},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'P'})},sys_FileManager:{getDocumentSource:async()=>source,getDocumentFootprintSources:async()=>[]},pcb_Net:{getAllNetsName:async()=>['N']},pcb_PrimitiveComponent:{getAll:async()=>[]},pcb_Drc:{check:async()=>[]},pcb_Document:{save:async()=>{calls.save++;return true;}}};
 for(const [kind,name]of Object.entries({lines:'Line',vias:'Via',arcs:'Arc',polylines:'Polyline',pours:'Pour'}))eda['pcb_Primitive'+name]={getAll:async()=>objects[kind].map(wrap),delete:async ids=>{calls.deleted.push({kind,ids:[...ids]});objects[kind]=objects[kind].filter(r=>!ids.includes(r.PrimitiveId));}};
 const make=values=>Object.fromEntries(fields.map(k=>[k,values[k]??null]));
 eda.pcb_PrimitiveLine.create=async(Net,Layer,StartX,StartY,EndX,EndY,LineWidth)=>{const r=make({PrimitiveId:'new-'+(++calls.create),Net,Layer,StartX,StartY,EndX,EndY,LineWidth,PrimitiveLock:false});objects.lines.push(r);return wrap(r);};
 eda.pcb_PrimitiveVia.create=async(Net,X,Y,HoleDiameter,Diameter)=>{const r=make({PrimitiveId:'via-'+(++calls.create),Net,X,Y,HoleDiameter,Diameter,PrimitiveLock:false});objects.vias.push(r);return wrap(r);};
 const input={mode:'apply',runId:'run1',target:{project:'P',document:'D'},selectedNets:['N'],mutableNets:[],layerIds:[1,2],pads:[],before:{objects:structuredClone(objects),sourceInvariantHash:digest('[]'),footprintHash:digest([])},expected:{segments:[{net:'N',layer:1,width:6,x1:0,y1:0,x2:30,y2:0}],vias:[]}};
 return{eda,input,calls,objects,make};
}

function layerPolicyFixture() {
 const f=fixture(),layers=[1,15,16,2];
 const pads=[0,30].map((x,index)=>({id:'pad-'+index,net:'N',x,y:0,shapes:[{kind:'circle',center:[x,0],radius:4,layers:[15]}]}));
 const board={layers,pads,segments:[],vias:[]};
 const policy={units:'mil',layers:layers.map(id=>({id,signalRoutingAllowed:true})),nets:[{net:'N',defaultWireWidthMil:6,endpoints:[{endpoint:'SOURCE.1',padId:'pad-0'},{endpoint:'LOAD.1',padId:'pad-1'}],roles:[{name:'ordinary_signal',endpoints:['SOURCE.1','LOAD.1'],allowedLayers:[15]}]}]};
 f.input.layerIds=layers;f.input.pads=pads;
 return{...f,board,policy};
}

test('a declared inner signal layer reaches native apply and save with the compiled task',async()=>{
 const f=layerPolicyFixture(),task=compileTasks(f.board,f.policy)[0];
 assert.equal(task.status,'pending');assert.deepEqual(task.layers,[15]);
 f.input.tasks=[task];f.input.expected.segments[0].layer=task.layers[0];
 const result=await run(f.eda,f.input);
 assert.equal(result.status,'applied-verified-unsaved');assert.equal(f.objects.lines[0].Layer,15);
 assert.equal((await run(f.eda,{mode:'save',target:f.input.target,runId:f.input.runId})).saved,true);
});

test('explicitly reserved signal layers are rejected by task compilation before native writes',()=>{
 const f=layerPolicyFixture();f.policy.layers.find(layer=>layer.id===15).signalRoutingAllowed=false;
 assert.throws(()=>compileTasks(f.board,f.policy),/RESERVED_AUTO_ROUTING_LAYER:N/);
 assert.equal(f.calls.create,0);assert.deepEqual(f.calls.deleted,[]);assert.equal(f.calls.save,0);
});

test('native apply rejects copper on a layer outside the captured board stack before writes',async()=>{
 const f=fixture();f.input.expected.segments[0].layer=15;
 await assert.rejects(()=>run(f.eda,f.input),/INVALID_ROUTING_WRITE_SCOPE/);
 assert.equal(f.calls.create,0);assert.deepEqual(f.calls.deleted,[]);assert.equal(f.calls.save,0);
});
test('native apply verifies shared geometry and saves in a separate step',async()=>{const f=fixture(),r=await run(f.eda,f.input);assert.equal(r.status,'applied-verified-unsaved');assert.equal(f.calls.save,0);assert.equal((await run(f.eda,{mode:'save',target:f.input.target,runId:'run1'})).status,'saved');assert.equal(f.calls.save,1);});
test('changed baseline and invalid target are rejected before writes',async()=>{const f=fixture();f.input.before.sourceInvariantHash='bad';await assert.rejects(()=>run(f.eda,f.input),/PCB_BASELINE_CHANGED/);assert.equal(f.calls.create,0);f.input.target.document='WRONG';await assert.rejects(()=>run(f.eda,f.input),/TARGET_CHANGED/);});
test('confirmed DRC failure removes only the new objects and does not save',async()=>{const f=fixture();f.eda.pcb_Drc.check=async()=>f.objects.lines.length?[{name:'clearance'}]:[];const r=await run(f.eda,f.input);assert.equal(r.status,'rolled-back');assert.equal(f.objects.lines.length,0);assert.equal(f.calls.save,0);});
test('failed rework restores old line and via geometry while retaining foreign and locked copper',async()=>{
 const f=fixture();
 f.objects.lines.push(
  f.make({PrimitiveId:'old-line',Net:'N',Layer:1,LineWidth:8,StartX:0,StartY:0,EndX:30,EndY:0,PrimitiveLock:false}),
  f.make({PrimitiveId:'foreign-line',Net:'OTHER',Layer:2,LineWidth:10,StartX:0,StartY:100,EndX:30,EndY:100,PrimitiveLock:false}),
  f.make({PrimitiveId:'locked-line',Net:'OTHER',Layer:1,LineWidth:12,StartX:0,StartY:120,EndX:30,EndY:120,PrimitiveLock:true}),
 );
 f.objects.vias.push(
  f.make({PrimitiveId:'old-via',Net:'N',X:30,Y:0,HoleDiameter:12,Diameter:24,PrimitiveLock:false}),
  f.make({PrimitiveId:'locked-via',Net:'OTHER',X:30,Y:120,HoleDiameter:10,Diameter:22,PrimitiveLock:true}),
 );
 f.eda.pcb_Net.getAllNetsName=async()=>['N','OTHER'];
 for(const rows of Object.values(f.objects))rows.sort((a,b)=>a.PrimitiveId.localeCompare(b.PrimitiveId));
 const before=structuredClone(f.objects);
 f.input.before.objects=structuredClone(before);f.input.mutableNets=['N'];
 f.input.expected={segments:[{net:'N',layer:1,width:8,x1:0,y1:20,x2:30,y2:20}],vias:[{net:'N',x:30,y:20,hole:12,diameter:24,layers:f.input.layerIds}]};
 f.eda.pcb_Drc.check=async()=>f.objects.lines.some(line=>line.Net==='N'&&line.StartY===20)?[{errorType:'Clearance Error',objs:['candidate','foreign-line']}]:[];
 const result=await run(f.eda,f.input);
 assert.equal(result.status,'rolled-back',JSON.stringify(result));assert.equal(result.error,'NATIVE_DRC_FAILED');assert.equal(f.calls.save,0);
 for(const kind of ['lines','vias']){
  const withoutIds=rows=>rows.map(({PrimitiveId,...row})=>row).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(withoutIds(f.objects[kind]),withoutIds(before[kind]),kind+' geometry restored');
  assert.deepEqual(f.objects[kind].filter(row=>row.Net==='OTHER'),before[kind].filter(row=>row.Net==='OTHER'),kind+' foreign identities retained');
 }
 const deletedIds=f.calls.deleted.flatMap(call=>call.ids);
 assert.ok(deletedIds.includes('old-line')&&deletedIds.includes('old-via'));
 assert.ok(deletedIds.some(id=>id.startsWith('new-'))&&deletedIds.some(id=>id.startsWith('via-')),'new candidate copper was removed');
 assert.ok(!deletedIds.some(id=>['foreign-line','locked-line','locked-via'].includes(id)));
 assert.equal(f.calls.create,4,'candidate line/via and both restored originals');
});

test('locked line or via in a rework net blocks before deleting any original copper',async()=>{
 for(const kind of ['lines','vias']){
  const f=fixture();
  const copper=kind==='lines'?{Layer:1,LineWidth:8,StartX:0,StartY:0,EndX:30,EndY:0}:{X:30,Y:0,HoleDiameter:12,Diameter:24};
  f.objects[kind].push(f.make({PrimitiveId:'locked-original',Net:'N',PrimitiveLock:true,...copper}));
  f.input.before.objects=structuredClone(f.objects);f.input.mutableNets=['N'];
  await assert.rejects(()=>run(f.eda,f.input),/LOCKED_REWORK_NET/);
  assert.deepEqual(f.objects,f.input.before.objects);assert.deepEqual(f.calls.deleted,[]);assert.equal(f.calls.create,0);assert.equal(f.calls.save,0);
 }
});
test('unconfirmed primitive creation stops with a journal and never saves',async()=>{const f=fixture();f.eda.pcb_PrimitiveLine.create=async()=>undefined;const r=await run(f.eda,f.input);assert.equal(r.status,'needs-attention');assert.equal(f.calls.save,0);});

const groupedDiagnostics=()=>[
 {name:'Connection Error',count:2,list:[{name:'GND',count:2,list:[{errorType:'Connection Error',objs:['pad-a']},{errorType:'Connection Error',objs:['pad-b']}]}]},
 {name:'Netlist Error',count:1,list:[{name:'Netlist Error',count:1,list:[{errorType:'Netlist Error',ruleName:'Import Changes'}]}]},
];
test('native capture counts physical leaves separately from connection and netlist groups',async()=>{
 const f=fixture();f.eda.pcb_Drc.check=async()=>groupedDiagnostics();
 f.eda.pcb_ManufactureData={getDsnFile:async()=>({text:async()=>'(pcb test)'})};f.eda.pcb_PrimitivePad={getAll:async()=>[]};
 const result=await run(f.eda,{mode:'capture',target:f.input.target});
 assert.equal(result.physicalDrcCount,0);assert.equal(result.drcSummary.connectionErrorCount,2);assert.equal(result.drcSummary.netlistErrorCount,1);
});
test('partial native routing can apply and save while unrelated unrouted nets remain',async()=>{
 const f=fixture();f.eda.pcb_Drc.check=async()=>groupedDiagnostics();
 const result=await run(f.eda,f.input);assert.equal(result.status,'applied-verified-unsaved');
 assert.equal((await run(f.eda,{mode:'save',target:f.input.target,runId:'run1'})).saved,true);
});
test('a physical error nested beside connection groups still rolls back only new copper',async()=>{
 const f=fixture();f.eda.pcb_Drc.check=async()=>f.objects.lines.length?[...groupedDiagnostics(),{name:'Clearance Error',count:2,list:[{name:'Common',list:[{errorType:'Clearance Error',objs:['new-1','pad-a']},{errorType:'Clearance Error',objs:['new-1','pad-b']}]}]}]:groupedDiagnostics();
 const result=await run(f.eda,f.input);assert.equal(result.status,'rolled-back');assert.equal(f.objects.lines.length,0);assert.equal(f.calls.save,0);
});

test('compatibility rejection happens before any EDA call and keeps the old journal',async t=>{
 const keys=['__flitrealizeRoutingTransaction','__natureCraftSesImport','__natureCraftAutorouteTask','__flitrealizeBst2AutoRouteTrial'];
 t.after(()=>{for(const key of keys)delete globalThis[key];});
 for(const key of keys){
  for(const other of keys)delete globalThis[other];
  const f=fixture(),journal={status:'running',saved:false,target:{project:'OTHER',document:'OTHER'}};
  globalThis[key]=journal;let calls=0;
  f.eda.dmt_SelectControl.getCurrentDocumentInfo=async()=>{calls++;return{uuid:'D',documentType:3};};
  await assert.rejects(()=>run(f.eda,f.input),error=>{assert.equal(error.compatibility.state,'blocked');const finding=error.compatibility.findings.find(v=>v.key===key);assert.equal(finding.scope,'different-target');assert.ok(finding.reasons.includes('unsaved-or-unfinished'));return true;});
  assert.equal(calls,0);assert.equal(f.calls.create,0);assert.equal(f.calls.save,0);assert.equal(globalThis[key],journal);
 }
});

test('a second apply is blocked while the first request is reading its baseline',async t=>{
 const f=fixture(),original=f.eda.dmt_SelectControl.getCurrentDocumentInfo;
 let release,entered;const pending=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
 f.eda.dmt_SelectControl.getCurrentDocumentInfo=async()=>{entered();await pending;return original();};
 const first=run(f.eda,f.input);await ready;
 assert.equal(globalThis.__flitrealizeRoutingTransaction.status,'preparing');
 await assert.rejects(()=>run(f.eda,{...f.input,runId:'run2'}),/UNRESOLVED_ROUTING_TRANSACTION/);
 assert.equal(f.calls.create,0);release();
 assert.equal((await first).status,'applied-verified-unsaved');assert.equal(f.calls.create,1);
 t.after(()=>{delete globalThis.__flitrealizeRoutingTransaction;});
});

test('a known preflight rejection remains journaled and allows a corrected request without clearing it',async t=>{
 const f=fixture();f.input.before.sourceInvariantHash='bad';
 await assert.rejects(()=>run(f.eda,f.input),/PCB_BASELINE_CHANGED/);
 const rejected=globalThis.__flitrealizeRoutingTransaction;
 assert.equal(rejected.status,'preflight-rejected');assert.equal(rejected.writeStarted,false);assert.equal(f.calls.create,0);
 const inspect=await run(f.eda,{mode:'inspect',target:f.input.target});assert.equal(inspect.compatibility.state,'clear');
 f.input.before.sourceInvariantHash=digest('[]');assert.equal((await run(f.eda,f.input)).status,'applied-verified-unsaved');
 assert.equal(rejected.status,'preflight-rejected');assert.equal(f.calls.create,1);
 t.after(()=>{delete globalThis.__flitrealizeRoutingTransaction;});
});

const oldPhysical={errorType:'Clearance Error',ruleName:'clearance-6',objs:['old-line','old-pad'],distance:4};
test('an identical complete old physical DRC can remain through apply and save',async()=>{
 const f=fixture();f.input.before.drc=[oldPhysical];f.eda.pcb_Drc.check=async()=>[oldPhysical];
 const result=await run(f.eda,f.input);assert.equal(result.status,'applied-verified-unsaved');
 assert.equal(result.physicalDrcCount,1);assert.equal(result.drcSummary.comparison.retainedViolationCount,1);
 assert.deepEqual(result.drc,[oldPhysical]);assert.equal((await run(f.eda,{mode:'save',target:f.input.target,runId:'run1'})).saved,true);
});
test('same-count replacement, worsening and duplicate DRC records reject new copper',async()=>{
 for(const current of [[{...oldPhysical,objs:['new-1','old-pad']}],[{...oldPhysical,distance:3}],[oldPhysical,oldPhysical]]){
  const f=fixture();f.input.before.drc=[oldPhysical];f.eda.pcb_Drc.check=async()=>f.objects.lines.length?current:[oldPhysical];
  const result=await run(f.eda,f.input);assert.equal(result.status,'rolled-back');assert.equal(f.objects.lines.length,0);assert.equal(f.calls.save,0);
 }
});
test('missing or incomplete old physical DRC evidence blocks before writes',async()=>{
 for(const baseline of [undefined,[{name:'clearance',count:1}]]){
  const f=fixture();f.input.before.drc=baseline;f.eda.pcb_Drc.check=async()=>baseline??[oldPhysical];
  await assert.rejects(()=>run(f.eda,f.input),/DRC_BASELINE_UNPROVEN/);assert.equal(f.calls.create,0);
 }
});
test('a save-only failure retries only save and a saved readback failure retains the saved fact',async()=>{
 const f=fixture();assert.equal((await run(f.eda,f.input)).status,'applied-verified-unsaved');
 f.eda.pcb_Document.save=async()=>{f.calls.save++;return false;};
 const request={mode:'save',target:f.input.target,runId:'run1'};
 assert.equal((await run(f.eda,request)).status,'save-failed');assert.equal(f.calls.create,1);
 const source=f.eda.sys_FileManager.getDocumentSource;
 f.eda.pcb_Document.save=async()=>{f.calls.save++;f.eda.sys_FileManager.getDocumentSource=async()=>{throw Error('readback lost');};return true;};
 const saved=await run(f.eda,request);assert.equal(saved.status,'saved-readback-failed');assert.equal(saved.saved,true);
 f.eda.sys_FileManager.getDocumentSource=source;
 assert.equal((await run(f.eda,request)).status,'saved');assert.equal(f.calls.save,2);assert.equal(f.calls.create,1);
});
test('an unknown write journal cannot be replayed',async()=>{
 const f=fixture();f.eda.pcb_PrimitiveLine.create=async()=>undefined;
 assert.equal((await run(f.eda,f.input)).status,'needs-attention');
 await assert.rejects(()=>run(f.eda,f.input),/UNRESOLVED_ROUTING_TRANSACTION/);assert.equal(f.calls.save,0);
});

test('a thrown or unconfirmed save is unknown and cannot be retried',async()=>{
 for(const thrown of [true,false]){
  const f=fixture();await run(f.eda,f.input);
  f.eda.pcb_Document.save=async()=>{f.calls.save++;if(thrown)throw Error('save reply lost');};
  const request={mode:'save',target:f.input.target,runId:'run1'},result=await run(f.eda,request);
  assert.equal(result.status,'outcome-unknown');assert.equal(result.saved,null);
  await assert.rejects(()=>run(f.eda,request),/SAVE_STATE_INVALID/);assert.equal(f.calls.save,1);
 }
});
