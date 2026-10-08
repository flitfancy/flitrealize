import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {officialCliControl,resolveOfficialCli} from '../scripts/providers/easyeda-pro/cli-channel.mjs';

const fixtureFile=fileURLToPath(new URL('./helpers/official-cli-fixture.mjs',import.meta.url));
async function fixture(t,{mode='normal',code='return {count:eda.probe()};'}={}){
 const home=await mkdtemp(join(tmpdir(),'flit-cli-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const file=join(home,'code.js'),state=join(home,'renderer.json');await writeFile(file,code);
 const settings={executable:'fixture',home,timeoutMs:5000,runner:(_,args,options)=>spawnSync(process.execPath,[fixtureFile,...args],{...options,env:{...process.env,CLI_FIXTURE_STATE:state,CLI_FIXTURE_MODE:mode}})};
 return{home,file,state,settings,execute:extra=>officialCliControl({command:'execute',codeFile:file,windowId:'A',requestId:randomUUID(),...extra},settings),readState:async()=>JSON.parse(await readFile(state,'utf8'))};
}
test('official CLI transports large Unicode source within Windows argument limits and preserves API bindings',async t=>{
 const payload=randomBytes(80000).toString('base64')+'汉字α\\"';
 const f=await fixture(t,{code:`\uFEFFreturn {count:eda.probe(),text:${JSON.stringify(payload)}};`});
 const result=await f.execute();assert.equal(result.success,true);assert.equal(result.result.text,payload);assert.equal(result.result.count,1);
 const state=await f.readState();assert.ok(state.calls.length>3);assert.ok(state.calls.every(call=>call.length<16000));assert.equal(state.executions,1);
 const queried=await officialCliControl({command:'request',sessionId:'A',requestId:result.request.requestId},f.settings);assert.equal(queried.request.status,'succeeded');
});
test('lost execute reply is unknown, original request can be reconciled, and the same ID is never redispatched',async t=>{
 const f=await fixture(t,{mode:'lose-execute'}),requestId=randomUUID();
 await assert.rejects(f.execute({requestId}),e=>e.executionOutcome==='unknown'&&e.request.requestId===requestId);
 const queried=await officialCliControl({command:'request',sessionId:'A',requestId},f.settings);
 assert.equal(queried.request.status,'succeeded');assert.equal(queried.request.result.count,1);
 await assert.rejects(f.execute({requestId}),/already has a receipt/);assert.equal((await f.readState()).executions,1);
 await assert.rejects(officialCliControl({command:'request',sessionId:'B',requestId},f.settings),/No official CLI request receipt/);
});
test('staging failure is explicitly not dispatched and no Action body runs',async t=>{
 const f=await fixture(t,{mode:'fail-stage'}),requestId=randomUUID();
 await assert.rejects(f.execute({requestId}),e=>e.executionOutcome==='not-dispatched'&&e.request.status==='not-dispatched');
 assert.equal((await f.readState()).executions,0);
 const q=await officialCliControl({command:'request',sessionId:'A',requestId},f.settings);assert.equal(q.request.status,'not-dispatched');
});
test('script failure has a known terminal record without discarding its error',async t=>{
 const f=await fixture(t,{code:'eda.probe();throw Object.assign(Error("probe failed"),{code:"PROBE_FAILURE"});'});
 await assert.rejects(f.execute(),e=>e.code==='PROBE_FAILURE'&&e.executionOutcome==='known'&&e.request.status==='failed');assert.equal((await f.readState()).executions,1);
});
test('session ambiguity, disconnected editors, and version mismatch reject before dispatch',async t=>{
 for(const mode of ['ambiguous','disconnected','mismatch']){
  const f=await fixture(t,{mode});await assert.rejects(f.execute({windowId:undefined}),/Choose an existing|versions differ/);
  assert.equal((await f.readState()).executions,0);
 }
});
test('official CLI executable resolution is host-specific and never supplies an author path',()=>{
 assert.equal(resolveOfficialCli(process.execPath),process.execPath);assert.throws(()=>resolveOfficialCli(undefined,{env:{},platform:'linux'}),/Specify --cli-executable/);
});
test('concurrent claim of one request ID dispatches once and leaves a complete receipt',async t=>{
 const f=await fixture(t),requestId=randomUUID();const outcomes=await Promise.allSettled([f.execute({requestId}),f.execute({requestId})]);
 const details=JSON.stringify(outcomes.map(r=>r.status==='rejected'?{status:r.status,error:r.reason.message,code:r.reason.code,request:r.reason.request}:{status:r.status}));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1,details);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1,details);
 const q=await officialCliControl({command:'request',sessionId:'A',requestId},f.settings);assert.equal(q.request.status,'succeeded');assert.equal((await f.readState()).executions,1);
});
test('an unavailable result channel is inspectable and blocks every execution before upload',async t=>{
 const f=await fixture(t,{mode:'no-result-channel'});assert.equal((await officialCliControl({command:'status'},f.settings)).status,'incompatible');
 await assert.rejects(f.execute(),e=>e.code==='CLI_RESULT_CHANNEL_UNAVAILABLE');assert.equal((await f.readState()).executions,0);
 assert.equal((await f.readState()).calls.some(c=>c.command==='invoke'),false);
});
test('request reconciliation rejects another ID even with the same session and code hash',async t=>{
 const f=await fixture(t,{mode:'wrong-query'}),requestId=randomUUID();await assert.rejects(f.execute({requestId}),e=>e.executionOutcome==='unknown');
 for(let i=0;i<2;i++)await assert.rejects(officialCliControl({command:'request',sessionId:'A',requestId},f.settings),/CLI_REQUEST_IDENTITY_MISMATCH/);
 assert.equal((await f.readState()).executions,1);
});
