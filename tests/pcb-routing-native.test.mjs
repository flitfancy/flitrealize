import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {digest} from '../scripts/pcb-routing/provider.mjs';
const root=new URL('../scripts/',import.meta.url);
const shared=['pcb-routing/geometry.mjs','providers/easyeda-pro/source-invariant.mjs'].map(p=>fs.readFileSync(new URL(p,root),'utf8').replace(/\bexport\s+/g,'')).join('\n');
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
