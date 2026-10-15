import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runtimeCache,ensureRuntime,runRouter} from '../../scripts/pcb-routing/runtime.mjs';

async function routerFixture(t) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'routing-process-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 return{
  runtime:{javaExe:path.join(directory,'java runtime','java'),jarPath:path.join(directory,'router binary.jar')},
  settings:{input:path.join(directory,'input board.dsn'),output:path.join(directory,'output board.ses'),result:path.join(directory,'route result.json'),log:path.join(directory,'router.log'),layers:[16,2],layerOrder:[1,15,16,2],timeoutMs:1234},
 };
}
test('the runtime cache is per user and independent of the PCB project',()=>{
 assert.equal(runtimeCache({platform:'linux',home:'/users/alice',env:{}}),path.resolve('/users/alice/.cache/flitrealize/runtimes/freerouting/2.4.1'));
 assert.equal(runtimeCache({platform:'darwin',home:'/users/alice',env:{}}),path.resolve('/users/alice/Library/Caches/FlitRealize/freerouting/2.4.1'));
});
test('an incorrect cached binary is rejected before Java runs',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'routing-runtime-'));
 try{const jar=path.join(dir,'bad.jar'),runtime=path.join(dir,'runtime.json');await fs.writeFile(jar,'bad');await fs.writeFile(runtime,JSON.stringify({freeroutingVersion:'2.4.1',jarPath:jar,javaExe:'never-execute'}));await assert.rejects(()=>ensureRuntime({runtimeFile:runtime}),/CHECKSUM_MISMATCH/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('invalid process budgets and heap flags never launch a process',async()=>{
 for(const settings of [{heap:'2g -Dattack=true'},{maxPasses:NaN},{timeoutMs:-1}])await assert.rejects(()=>runRouter({javaExe:'never-execute'},settings),/INVALID_/);
});
test('invalid ignore lists never launch a process with an ambiguous class selection',async()=>{
 for(const ignoredClasses of ['NET',['NET,OTHER'],['-other-option']])await assert.rejects(()=>runRouter({javaExe:'never-execute'},{ignoredClasses}),/INVALID_IGNORED_NET_CLASSES/);
});

test('valid routing preserves path arguments, declared layer order and ignored classes through the process boundary',async t=>{
 const {runtime,settings}=await routerFixture(t),calls=[];
 const report={final_state:'COMPLETED',output_written:true,routes:2};
 const runner=async(executable,args,options)=>{
  calls.push({executable,args,options});
  await fs.writeFile(settings.result,JSON.stringify(report));
  await fs.writeFile(settings.output,'(session test)');
  return{stdout:'routing complete\n',stderr:'diagnostic\n'};
 };
 const result=await runRouter(runtime,{...settings,ignoredClasses:['','default','OTHER'],heap:'512m',maxPasses:7,optimize:false,fanout:true},{runner});
 assert.equal(calls.length,1);
 const {executable,args,options}=calls[0];
 assert.equal(executable,runtime.javaExe);
 assert.deepEqual(args.slice(0,10),['-Xmx512m','-Djava.awt.headless=true','-jar',runtime.jarPath,'-de',settings.input,'-do',settings.output,'-mp','7']);
 for(const flag of [
  '--router.layers.routable=false,false,true,true','--router.optimizer.enabled=false','--router.fanout.enabled=true',
  '--router.strict_drc=true','--router.automatic_neckdown=false','--gui.enabled=false','--api_server.enabled=false',
  '--profile.allow_telemetry=false','--usage_and_diagnostic_data.disable_analytics=true',
  '--user_data_path='+path.join(path.dirname(settings.output),'fr-state'),'--router.result_json='+settings.result,
 ])assert.ok(args.includes(flag),flag);
 assert.equal(args[args.indexOf('-inc')+1],',default,OTHER');
 assert.deepEqual(options,{windowsHide:true,timeout:settings.timeoutMs,maxBuffer:4*1024*1024});
 assert.deepEqual(result.report,report);assert.ok(Number.isFinite(result.seconds)&&result.seconds>=0);
 assert.equal(await fs.readFile(settings.log,'utf8'),'routing complete\ndiagnostic\n');
});

test('default routing options enable optimization and omit an empty ignore selection',async t=>{
 const {runtime,settings}=await routerFixture(t);let calls=0;
 await runRouter(runtime,settings,{runner:async(_executable,args)=>{
  calls++;assert.equal(args[0],'-Xmx2g');assert.equal(args[args.indexOf('-mp')+1],'5');
  assert.ok(args.includes('--router.optimizer.enabled=true'));assert.ok(args.includes('--router.fanout.enabled=false'));
  assert.ok(!args.includes('-inc'));
  await fs.writeFile(settings.result,JSON.stringify({final_state:'COMPLETED',output_written:true}));
  return{stdout:'',stderr:''};
 }});
 assert.equal(calls,1);
});

test('a failed router process retains its diagnostics and original failure without reporting success',async t=>{
 const {runtime,settings}=await routerFixture(t);let calls=0;
 const failure=Object.assign(new Error('router exited with status 2'),{code:2,stdout:'partial route\n',stderr:'invalid DSN\n'});
 await assert.rejects(()=>runRouter(runtime,settings,{runner:async()=>{calls++;throw failure;}}),error=>error===failure);
 assert.equal(calls,1);assert.equal(await fs.readFile(settings.log,'utf8'),'partial route\ninvalid DSN\n');
 await assert.rejects(()=>fs.access(settings.result),{code:'ENOENT'});
});

test('a router timeout uses the configured process budget and is never retried',async t=>{
 const {runtime,settings}=await routerFixture(t);let calls=0;
 const failure=Object.assign(new Error('process timed out'),{code:'ETIMEDOUT',killed:true,signal:'SIGTERM',stdout:'searching\n',stderr:'budget expired\n'});
 await assert.rejects(()=>runRouter(runtime,{...settings,timeoutMs:25},{runner:async(_executable,_args,options)=>{
  calls++;assert.equal(options.timeout,25);throw failure;
 }}),error=>error===failure&&error.killed===true);
 assert.equal(calls,1);assert.equal(await fs.readFile(settings.log,'utf8'),'searching\nbudget expired\n');
});

test('a successful process still rejects incomplete, malformed and missing result reports',async t=>{
 const {runtime,settings}=await routerFixture(t);
 for(const report of [{final_state:'RUNNING',output_written:true},{final_state:'COMPLETED',output_written:false},{final_state:'COMPLETED'}]){
  await assert.rejects(()=>runRouter(runtime,settings,{runner:async()=>{
   await fs.writeFile(settings.result,JSON.stringify(report));return{stdout:'process exited\n',stderr:''};
  }}),/ROUTER_DID_NOT_COMPLETE/);
 }
 await assert.rejects(()=>runRouter(runtime,settings,{runner:async()=>{
  await fs.writeFile(settings.result,'not JSON');return{stdout:'',stderr:''};
 }}),SyntaxError);
 await fs.rm(settings.result);
 await assert.rejects(()=>runRouter(runtime,settings,{runner:async()=>({stdout:'',stderr:''})}),{code:'ENOENT'});
});
