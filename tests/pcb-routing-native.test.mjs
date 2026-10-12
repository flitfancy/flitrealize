import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {digest} from '../scripts/pcb-routing/provider.mjs';
const root=new URL('../scripts/',import.meta.url);
const shared=['pcb-routing/geometry.mjs','providers/easyeda-pro/source-invariant.mjs','providers/easyeda-pro/drc-summary.mjs','providers/easyeda-pro/routing-compatibility.mjs'].map(p=>fs.readFileSync(new URL(p,root),'utf8').replace(/\bexport\s+/g,'')).join('\n');
const code=shared+'\n'+fs.readFileSync(new URL('providers/easyeda-pro/routing-native.js',root),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor,run=new AsyncFunction('eda','flitrealizeInput',code);
function fixture(){
 delete globalThis.__flitrealizeRoutingTransaction;
 const objects={lines:[],vias:[],arcs:[],polylines:[],pours:[]},calls={save:0,create:0},source='';
 const fields=['PrimitiveId','Net','Layer','LineWidth','StartX','StartY','EndX','EndY','X','Y','Diameter','HoleDiameter','Rotation','PrimitiveLock'];
 const wrap=r=>Object.fromEntries(fields.map(k=>['getState_'+k,()=>r[k]??null]));
 const eda={dmt_SelectControl:{getCurrentDocumentInfo:async()=>({uuid:'D',documentType:3})},dmt_Project:{getCurrentProjectInfo:async()=>({uuid:'P'})},sys_FileManager:{getDocumentSource:async()=>source,getDocumentFootprintSources:async()=>[]},pcb_Net:{getAllNetsName:async()=>['N']},pcb_PrimitiveComponent:{getAll:async()=>[]},pcb_Drc:{check:async()=>[]},pcb_Document:{save:async()=>{calls.save++;return true;}}};
 for(const [kind,name]of Object.entries({lines:'Line',vias:'Via',arcs:'Arc',polylines:'Polyline',pours:'Pour'}))eda['pcb_Primitive'+name]={getAll:async()=>objects[kind].map(wrap),delete:async ids=>{objects[kind]=objects[kind].filter(r=>!ids.includes(r.PrimitiveId));}};
 const make=values=>Object.fromEntries(fields.map(k=>[k,values[k]??null]));
 eda.pcb_PrimitiveLine.create=async(Net,Layer,StartX,StartY,EndX,EndY,LineWidth)=>{const r=make({PrimitiveId:'new-'+(++calls.create),Net,Layer,StartX,StartY,EndX,EndY,LineWidth,PrimitiveLock:false});objects.lines.push(r);return wrap(r);};
 eda.pcb_PrimitiveVia.create=async(Net,X,Y,HoleDiameter,Diameter)=>{const r=make({PrimitiveId:'via-'+(++calls.create),Net,X,Y,HoleDiameter,Diameter,PrimitiveLock:false});objects.vias.push(r);return wrap(r);};
 const input={mode:'apply',runId:'run1',target:{project:'P',document:'D'},selectedNets:['N'],mutableNets:[],layerIds:[1,2],pads:[],before:{objects:structuredClone(objects),sourceInvariantHash:digest('[]'),footprintHash:digest([])},expected:{segments:[{net:'N',layer:1,width:6,x1:0,y1:0,x2:30,y2:0}],vias:[]}};
 return{eda,input,calls,objects};
}
test('native apply verifies shared geometry and saves in a separate step',async()=>{const f=fixture(),r=await run(f.eda,f.input);assert.equal(r.status,'applied-verified-unsaved');assert.equal(f.calls.save,0);assert.equal((await run(f.eda,{mode:'save',target:f.input.target,runId:'run1'})).status,'saved');assert.equal(f.calls.save,1);});
test('changed baseline and invalid target are rejected before writes',async()=>{const f=fixture();f.input.before.sourceInvariantHash='bad';await assert.rejects(()=>run(f.eda,f.input),/PCB_BASELINE_CHANGED/);assert.equal(f.calls.create,0);f.input.target.document='WRONG';await assert.rejects(()=>run(f.eda,f.input),/TARGET_CHANGED/);});
test('confirmed DRC failure removes only the new objects and does not save',async()=>{const f=fixture();f.eda.pcb_Drc.check=async()=>f.objects.lines.length?[{name:'clearance'}]:[];const r=await run(f.eda,f.input);assert.equal(r.status,'rolled-back');assert.equal(f.objects.lines.length,0);assert.equal(f.calls.save,0);});
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
