import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,readdir,rm,stat,writeFile,mkdir} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {officialCliControl,resolveOfficialCli,probeOfficialCliCodeFile,confirmedFileBudget} from '../scripts/providers/easyeda-pro/cli-channel.mjs';

const fixtureFile=fileURLToPath(new URL('./helpers/official-cli-fixture.mjs',import.meta.url));
async function fixture(t,{mode='normal',code='return {count:eda.probe()};',fileDelivery=false}={}){
 const home=await mkdtemp(join(tmpdir(),'flit-cli-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const file=join(home,'code.js'),state=join(home,'renderer.json');await writeFile(file,code);
 const executable=join(home,'client.exe');await writeFile(executable,'fixture-client');
 const m=await stat(executable),identity={executable:await realpath(executable),size:m.size,mtimeMs:m.mtimeMs,ctimeMs:m.ctimeMs,resources:[]};
 const settings={executable,home,timeoutMs:5000,...(fileDelivery?{codeFileCapability:{schemaVersion:1,supported:true,identity,bridgeVersion:'fixture-version',maxCodeBytes:1024*1024}}:{}),runner:(_,args,options)=>spawnSync(process.execPath,[fixtureFile,...args],{...options,env:{...process.env,CLI_FIXTURE_STATE:state,CLI_FIXTURE_MODE:mode}})};
 return{home,file,state,settings,execute:extra=>officialCliControl({command:'execute',codeFile:file,windowId:'A',requestId:randomUUID(),...extra},settings),readState:async()=>JSON.parse(await readFile(state,'utf8'))};
}

test('ordinary CLI registration records file support consumed by the execution channel',async t=>{
 const payload=randomBytes(80000).toString('base64')+'汉字α';
 const f=await fixture(t,{code:`return {count:eda.probe(),text:${JSON.stringify(payload)}};`});
 const prior=process.env.FLITREALIZE_HOME;process.env.FLITREALIZE_HOME=f.home;
 t.after(()=>{if(prior===undefined)delete process.env.FLITREALIZE_HOME;else process.env.FLITREALIZE_HOME=prior;});
 const module=new URL('../scripts/eda-host.mjs',import.meta.url);module.searchParams.set('registration-test',randomUUID());
 const {registerAdapter}=await import(module.href);
 const registered=await registerAdapter('easyeda-pro',undefined,{channel:'cli',cliExecutable:f.settings.executable,windowId:'A',runner:f.settings.runner});
 const profile=JSON.parse(await readFile(join(f.home,'host.json'),'utf8'));
 const adapter=profile.adapters['easyeda-pro'];
 assert.equal(adapter.codeFileCapability?.supported,true,'Normal registration must not leave the fast path unconfigured');
 assert.equal(registered.codeFileCapability.supported,true);
 assert.equal((await f.readState()).executions,0,'Capability probe must call no EDA API');
 f.settings.codeFileCapability=adapter.codeFileCapability;
 const result=await f.execute();assert.equal(result.result.text,payload);
 const state=await f.readState();assert.equal(state.executions,1);
 const uploads=state.calls.filter(c=>c.codeFile?.includes('.upload-'));assert.equal(uploads.length,1);
});

test('file capability probe refuses unavailable channels, unconfirmed versions and ambiguous targets without an invocation',async t=>{
 for(const mode of ['disconnected','no-result-channel','mismatch','ambiguous']){
  const f=await fixture(t,{mode}),cap=await probeOfficialCliCodeFile(f.settings.executable,f.settings);
  assert.equal(cap.supported,false,mode);assert.ok(cap.reason,mode);
  const state=await f.readState();assert.equal(state.calls.some(c=>c.command==='invoke'),false,mode);assert.equal(state.executions,0);
 }
});

test('unsupported code-file probe leaves the argument channel usable and cleans its own temporary source',async t=>{
 const f=await fixture(t,{mode:'no-code-file'});
 const cap=await probeOfficialCliCodeFile(f.settings.executable,{...f.settings,windowId:'A'});
 assert.equal(cap.supported,false);assert.equal(cap.reason,'CLI_CODE_FILE_UNSUPPORTED');
 assert.equal((await f.readState()).executions,0);
 assert.ok(!(await allFiles(f.home)).some(p=>p.includes('code-file-')&&p.endsWith('.js')));
 f.settings.codeFileCapability=cap;const r=await f.execute();assert.equal(r.result.count,1);assert.equal(r.transport.delivery,'argument-chunks');
});

test('confirmed file cache is reusable until executable identity or bridge version changes',async t=>{
 const f=await fixture(t),cap=await probeOfficialCliCodeFile(f.settings.executable,{...f.settings,windowId:'A'});
 assert.equal(cap.supported,true);assert.equal((await f.readState()).executions,0);
 const doctor={versionMatch:true,bridgeVersion:'fixture-version'};
 assert.ok(await confirmedFileBudget(f.settings.executable,doctor,cap)>0);
 assert.equal(await confirmedFileBudget(f.settings.executable,{...doctor,bridgeVersion:'different'},cap),null);
 await writeFile(f.settings.executable,'updated-client-identity');
 assert.equal(await confirmedFileBudget(f.settings.executable,doctor,cap),null);
});

test('host ensure refreshes a legacy registration once and reuses confirmed file support',async t=>{
 const f=await fixture(t),prior=process.env.FLITREALIZE_HOME;process.env.FLITREALIZE_HOME=f.home;
 t.after(()=>{if(prior===undefined)delete process.env.FLITREALIZE_HOME;else process.env.FLITREALIZE_HOME=prior;});
 const module=new URL('../scripts/eda-host.mjs',import.meta.url);module.searchParams.set('ensure-test',randomUUID());
 const {runCliControl}=await import(module.href);
 const adapter={channel:'cli',cliExecutable:f.settings.executable,selectedWindowId:'A'};
 const profile={schemaVersion:1,hostId:randomUUID(),adapters:{'easyeda-pro':adapter}};
 const args={command:'ensure',eda:'easyeda-pro',windowId:'A',requireEda:true};
 const first=await runCliControl(args,profile,adapter,{runner:f.settings.runner});assert.equal(first.codeFileCapability.supported,true);
 const before=await f.readState(),confirmedAt=adapter.codeFileCapability.confirmedAt;
 assert.equal(before.calls.filter(c=>c.codeFile).length,1);assert.equal(before.executions,0);
 const second=await runCliControl(args,profile,adapter,{runner:f.settings.runner});assert.equal(second.codeFileCapability.confirmedAt,confirmedAt);
 const after=await f.readState();assert.equal(after.calls.filter(c=>c.codeFile).length,1,'A valid capability cache must not repeat the probe');
 assert.equal(after.executions,0);
 assert.equal(JSON.parse(await readFile(join(f.home,'host.json'),'utf8')).adapters['easyeda-pro'].codeFileCapability.supported,true);
});
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

async function allFiles(root){const out=[];for(const e of await readdir(root,{withFileTypes:true})){const p=join(root,e.name);if(e.isDirectory())out.push(...await allFiles(p));else out.push(p);}return out;}
test('confirmed file delivery preserves Unicode bytes, SHA, result and cleans owned upload files',async t=>{
 const payload=randomBytes(80000).toString('base64')+'汉字α\\"',f=await fixture(t,{fileDelivery:true,code:`\uFEFFreturn {count:eda.probe(),text:${JSON.stringify(payload)}};`});
 const result=await f.execute(),state=await f.readState();assert.equal(result.result.text,payload);assert.equal(state.executions,1);
 const uploads=state.calls.filter(c=>c.codeFile);assert.equal(uploads.length,1);assert.ok(uploads[0].codeBytes<Math.floor(1024*1024*.99));assert.ok(state.calls.every(c=>c.length<16000));
 assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));const q=await officialCliControl({command:'request',sessionId:'A',requestId:result.request.requestId},f.settings);assert.equal(q.request.status,'succeeded');
});
test('large incompressible source uses multiple byte-bounded files then executes exactly once',async t=>{
 const payload=randomBytes(1300000).toString('base64')+'汉字',f=await fixture(t,{fileDelivery:true,code:`return {count:eda.probe(),text:${JSON.stringify(payload)}};`});
 f.settings.codeFileCapability.maxCodeBytes=8*1024*1024;
 const result=await f.execute(),state=await f.readState(),uploads=state.calls.filter(c=>c.codeFile);assert.equal(result.result.text,payload);assert.equal(state.executions,1);assert.ok(uploads.length>1);
 assert.ok(uploads.every(c=>c.codeBytes<=Math.floor(1024*1024*.99)));assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
});
test('a smaller confirmed byte limit splits files without dropping any source data',async t=>{
 const payload=randomBytes(30000).toString('base64'),f=await fixture(t,{fileDelivery:true,code:`return {text:${JSON.stringify(payload)}};`});f.settings.codeFileCapability.maxCodeBytes=12000;
 const result=await f.execute(),uploads=(await f.readState()).calls.filter(c=>c.codeFile);assert.equal(result.result.text,payload);assert.ok(uploads.length>1);assert.ok(uploads.every(c=>c.codeBytes<=Math.floor(12000*.99)));
});
test('unknown or changed client identity/version/capability conservatively uses legacy chunks',async t=>{
 for(const kind of ['unknown','version','binary','resources','invalid-limit']){
  const f=await fixture(t,{fileDelivery:true});if(kind==='unknown')delete f.settings.codeFileCapability;else if(kind==='version')f.settings.codeFileCapability.bridgeVersion='other';else if(kind==='binary')await writeFile(f.settings.executable,'changed-client-binary');else if(kind==='resources'){await mkdir(join(f.home,'resources/app'),{recursive:true});await writeFile(join(f.home,'resources/app/app.js'),'new-client-resource');}else f.settings.codeFileCapability.maxCodeBytes=0;
  assert.equal((await f.execute()).success,true);assert.equal((await f.readState()).calls.filter(c=>c.codeFile).length,0);
 }
});
test('file upload failure is not dispatched, never retries through argv and cleans temporary files',async t=>{
 const f=await fixture(t,{fileDelivery:true,mode:'fail-stage'}),id=randomUUID();await assert.rejects(f.execute({requestId:id}),e=>e.executionOutcome==='not-dispatched');
 const state=await f.readState();assert.equal(state.executions,0);assert.equal(state.calls.filter(c=>c.codeFile).length,1);assert.ok(!state.calls.some(c=>c.command==='invoke'&&!c.codeFile));assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
});
test('file delivery lost execute reply remains unknown, reconciles the original ID and never replays',async t=>{
 const f=await fixture(t,{fileDelivery:true,mode:'lose-execute'}),id=randomUUID();await assert.rejects(f.execute({requestId:id}),e=>e.executionOutcome==='unknown');
 const q=await officialCliControl({command:'request',sessionId:'A',requestId:id},f.settings);assert.equal(q.request.status,'succeeded');await assert.rejects(f.execute({requestId:id}),/already has a receipt/);assert.equal((await f.readState()).executions,1);
 assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
});
test('file delivery refuses a wrong session and concurrent duplicate claims dispatch once',async t=>{
 const wrong=await fixture(t,{fileDelivery:true});await assert.rejects(wrong.execute({windowId:'B'}),/Choose an existing/);assert.equal((await wrong.readState()).calls.filter(c=>c.codeFile).length,0);
 const f=await fixture(t,{fileDelivery:true}),id=randomUUID(),results=await Promise.allSettled([f.execute({requestId:id}),f.execute({requestId:id})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.readState()).executions,1);
});

test('a limit smaller than the file wrapper falls back before any file upload',async t=>{
 const f=await fixture(t,{fileDelivery:true});f.settings.codeFileCapability.maxCodeBytes=400;
 assert.equal((await f.execute()).success,true);assert.equal((await f.readState()).calls.filter(c=>c.codeFile).length,0);
});
test('lost staging acknowledgement keeps the original request not-dispatched without replay',async t=>{
 const f=await fixture(t,{fileDelivery:true,mode:'lose-stage'}),id=randomUUID();
 await assert.rejects(f.execute({requestId:id}),e=>e.executionOutcome==='not-dispatched');
 const state=await f.readState();assert.equal(state.uploads.length,1);assert.equal(state.executions,0);
 await assert.rejects(f.execute({requestId:id}),/already has a receipt/);assert.equal((await f.readState()).calls.filter(c=>c.codeFile).length,1);
 const q=await officialCliControl({command:'request',sessionId:'A',requestId:id},f.settings);assert.equal(q.request.status,'not-dispatched');
 assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
});
test('file data corruption fails the original SHA before any Action body runs',async t=>{
 const f=await fixture(t,{fileDelivery:true}),run=f.settings.runner;
 f.settings.runner=(exe,args,options)=>{if(args.includes('--code-file')){const p=args[args.indexOf('--code-file')+1],code=readFileSync(p,'utf8');writeFileSync(p,code.replace(/chunk:"[^"]+"/,'chunk:'+JSON.stringify(gzipSync(Buffer.from('return {count:eda.probe(),corrupted:true};')).toString('base64'))));}return run(exe,args,options);};
 await assert.rejects(f.execute(),e=>e.executionOutcome==='known'&&e.request.actionStarted===false&&e.request.status==='failed'&&e.message==='CLI_CODE_HASH_MISMATCH');
 assert.equal((await f.readState()).executions,0);assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
});
test('upload refuses a preexisting temporary file and never deletes another owner file',async t=>{
 const f=await fixture(t,{fileDelivery:true}),id=randomUUID(),directory=join(f.home,'cli/easyeda-pro/requests',createHash('sha256').update('A').digest('hex'));
 await mkdir(directory,{recursive:true});const temporary=join(directory,id+'.upload-0.js');await writeFile(temporary,'other owner');
 await assert.rejects(f.execute({requestId:id}),e=>e.code==='EEXIST'&&e.executionOutcome==='not-dispatched');
 assert.equal(await readFile(temporary,'utf8'),'other owner');assert.equal((await f.readState()).executions,0);
});
test('file delivery honors the task deadline and cleans uploaded temporary files',async t=>{
 const f=await fixture(t,{fileDelivery:true});f.settings.timeoutMs=1;
 await assert.rejects(f.execute(),e=>e.code==='CLI_TASK_BUDGET_EXHAUSTED'&&e.executionOutcome==='not-dispatched');
 assert.equal((await f.readState()).executions,0);assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
});

test('file transport applies and saves only in the SDK mock and reconciles lost replies without repeating either',async t=>{
 for(const mode of ['normal','lose-execute']){
  const f=await fixture(t,{fileDelivery:true,mode,code:'return {applied:await eda.pcb_PrimitiveComponent.modify()};'});
  const execute=async id=>{if(mode==='normal')return f.execute({requestId:id});await assert.rejects(f.execute({requestId:id}),e=>e.executionOutcome==='unknown');const q=await officialCliControl({command:'request',sessionId:'A',requestId:id},f.settings);assert.equal(q.request.status,'succeeded');return q.request;};
  const applyId=randomUUID();await execute(applyId);await assert.rejects(f.execute({requestId:applyId}),/already has a receipt/);
  await writeFile(f.file,'return {saved:await eda.dmt_EditorControl.saveDocument("A")};');
  const saveId=randomUUID();await execute(saveId);await assert.rejects(f.execute({requestId:saveId}),/already has a receipt/);
  const state=await f.readState();assert.equal(state.applies,1);assert.equal(state.saves,1);assert.equal(state.calls.filter(c=>c.codeFile).length,2);
  assert.ok(!(await allFiles(f.home)).some(p=>p.includes('.upload-')));
 }
});
