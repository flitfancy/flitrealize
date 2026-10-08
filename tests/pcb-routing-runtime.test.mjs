import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runtimeCache,ensureRuntime,runRouter} from '../scripts/pcb-routing/runtime.mjs';
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
