import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execute,resolveWindow} from '../scripts/providers/easyeda-pro/pcb-layout.mjs';
import {applyLayout,inspectLayout,resumeLayoutSave} from '../scripts/pcb-layout/pcb-layout-execution.mjs';
import {fixture} from './helpers/pcb-layout-execution-fixture.mjs';

const requestId='11111111-1111-4111-8111-111111111111';
const hash=s=>createHash('sha256').update(s).digest('hex');
function failed(call,changes={}){
  const error={code:'SOURCE_CHANGED_RECONCILE',message:'SOURCE_CHANGED_RECONCILE'};
  return {status:'error',success:false,executionOutcome:'known',error,
    request:{requestId,windowId:call.windowId,sessionId:call.windowId,codeSha256:hash(call.code),status:'failed',actionStarted:true,error,...changes}};
}
async function invokeFailure(call,envelope,processFields={code:1}){
  return execute(call,{requestId,runner:async(_exe,args)=>{
    assert.equal(args[args.indexOf('--request-id')+1],requestId);
    throw Object.assign(Error('Process exited'),{stderr:JSON.stringify(envelope),stdout:'',...processFields});
  }});
}
test('provider retains exit-1 known business failure only for its exact request, code and target',async t=>{
  const f=await fixture(t),call={code:'const target="pcb";',codeFile:path.join(f.projectRoot,'operation.js'),windowId:'window',input:{config:f.options().config}};
  await fs.writeFile(call.codeFile,call.code);
  const response=await invokeFailure(call,failed(call));
  assert.equal(response.executionOutcome,'known');assert.equal(response.error.code,'SOURCE_CHANGED_RECONCILE');
  assert.deepEqual(response.executionBinding.target,{expectedProjectUuid:'project',expectedDocumentUuid:'pcb'});
  for(const changed of [{requestId:'other'},{windowId:'other'},{sessionId:'other'},{codeSha256:'other'},{status:'running'},{result:{status:'applied'}}]){
    assert.equal((await invokeFailure(call,failed(call,changed))).executionOutcome,'unknown',JSON.stringify(changed));
  }
  assert.equal((await invokeFailure(call,failed(call),{code:'ETIMEDOUT',killed:true})).executionOutcome,'unknown');
  assert.equal((await invokeFailure(call,{...failed(call),executionOutcome:'unknown'})).executionOutcome,'unknown');
  assert.equal((await invokeFailure(call,{...failed(call),error:{code:'different',message:'different'}})).executionOutcome,'unknown');
  const contradictory=await execute(call,{requestId,runner:async()=>{throw Object.assign(Error('exit'),{code:1,stdout:JSON.stringify(failed(call)),stderr:JSON.stringify({...failed(call),success:true})});}});
  assert.equal(contradictory.executionOutcome,'unknown');
  const missing=await execute(call,{requestId,runner:async()=>({stdout:'',stderr:''})});assert.equal(missing.executionOutcome,'unknown');
  const result={status:'inspected',document:{uuid:'pcb',parentProjectUuid:'project',documentType:3}},success={success:true,channel:'cli',result,request:{...failed(call).request,status:'succeeded',result}};
  const successCall=value=>execute(call,{requestId,runner:async()=>({stdout:JSON.stringify(value)})});
  assert.equal((await successCall(success)).success,true);
  for(const changed of [{...success,request:undefined},{...success,result:null},{...success,request:{...success.request,status:'failed'}},{...success,result:{...result,document:{...result.document,uuid:'wrong'}}}])assert.equal((await successCall(changed)).executionOutcome,'unknown');
  const bridge={...success,channel:'bridge',request:{...success.request,sessionId:'bridge-session'}};delete bridge.request.result;
  assert.equal((await successCall(bridge)).success,true);
  await assert.rejects(execute({...call,code:'changed'},{requestId,runner:async()=>{throw Error('Must not submit');}}),/Operation code changed/);
});
test('proven pre-dispatch save failure removes pending claim and resumes without another apply',async t=>{
  const f=await fixture(t),snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot);
  const first=await applyLayout({...f.options(),snapshot,plan,transport:async call=>call.phase==='save'?invokeFailure(call,failed(call,{actionStarted:false})):f.transport(call)});
  assert.equal(first.status,'save-failed');assert.equal(first.saved,false);assert.equal(first.error.code,'SOURCE_CHANGED_RECONCILE');
  await assert.rejects(fs.access(first.saveAttemptFile),{code:'ENOENT'});
  const native=JSON.parse(await fs.readFile(path.join(first.reportDir,'layout-save-result.json')));
  assert.equal(native.outcome,'settled');assert.equal(native.response.request.status,'failed');
  const recovered=await resumeLayoutSave({...f.options(),resumeSave:first.reportFile});
  assert.equal(recovered.status,'verified');assert.equal(f.calls.filter(p=>p==='apply').length,1);assert.equal(f.control.saves,1);
});
test('mismatched provider reply stays unknown and never continues to save or recovery',async t=>{
  const f=await fixture(t),snapshot=await inspectLayout(f.options()),plan=f.plan(snapshot);
  const result=await applyLayout({...f.options(),snapshot,plan,transport:call=>invokeFailure(call,failed(call,{windowId:'wrong-target'}))});
  assert.equal(result.status,'outcome-unknown');assert.equal(result.saved,null);assert.equal(f.control.saves,0);
  await assert.rejects(resumeLayoutSave({...f.options(),resumeSave:result.reportFile}),/SAVE_RECOVERY_UNRESOLVED/);
});
test('window discovery selects only a unique project session and rejects ambiguity',async t=>{
  const f=await fixture(t),projectRoot=f.projectRoot;
  await fs.mkdir(path.join(projectRoot,'copy'));
  const file=path.join(projectRoot,'copy','board.eprj3');await fs.writeFile(file,'fixture');
  const session={windowId:'project-window',path:file};
  const runner=windows=>async()=>({stdout:JSON.stringify({eda:{windows}})});
  assert.equal(await resolveWindow({projectRoot},{runner:runner([session,{windowId:'other',path:path.resolve('other/board.eprj3')}])}),'project-window');
  for(const windows of [[],[session,{...session,windowId:'duplicate'}]])await assert.rejects(resolveWindow({projectRoot},{runner:runner(windows)}),/Specify --window-id/);
});


test('save side effect followed by a terminal script error remains unknown and cannot be replayed',async t=>{
  const f=await fixture(t),snapshot=await inspectLayout(f.options());let effects=0;
  const first=await applyLayout({...f.options(),snapshot,plan:f.plan(snapshot),transport:async call=>{
    if(call.phase!=='save')return f.transport(call);
    effects++;
    return invokeFailure(call,failed(call,{actionStarted:true}));
  }});
  assert.equal(first.status,'outcome-unknown');assert.equal(first.saved,null);
  await fs.access(first.saveAttemptFile);
  await assert.rejects(resumeLayoutSave({...f.options(),resumeSave:first.reportFile}),/SAVE_RECOVERY_UNRESOLVED/);
  assert.equal(effects,1);assert.equal(f.control.saves,0);
});

test('window discovery canonicalizes aliases and rejects an outside target',async t=>{
  const f=await fixture(t),file=path.join(f.projectRoot,'board.eprj3'),alias=f.projectRoot+'-alias';
  await fs.writeFile(file,'fixture');
  await fs.symlink(f.projectRoot,alias,process.platform==='win32'?'junction':'dir');t.after(()=>fs.rm(alias,{recursive:true,force:true}));
  const runner=windows=>async()=>({stdout:JSON.stringify({eda:{windows}})});
  assert.equal(await resolveWindow({projectRoot:f.projectRoot},{runner:runner([{windowId:'same',path:path.join(alias,'board.eprj3')}])}),'same');
  const outside=await fixture(t),outsideFile=path.join(outside.projectRoot,'board.eprj3');await fs.writeFile(outsideFile,'fixture');
  const linked=path.join(f.projectRoot,'outside');await fs.symlink(outside.projectRoot,linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveWindow({projectRoot:f.projectRoot},{runner:runner([{windowId:'outside',path:path.join(linked,'board.eprj3')}])}),/Specify --window-id/);
});
