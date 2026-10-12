import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fineFixture} from './helpers/pcb-fine-recovery-fixture.mjs';
import {main} from '../scripts/pcb-layout.mjs';
import {preflightFineLayout} from '../scripts/pcb-layout/fine/workflow.mjs';

async function publicCall(f,stage,output,extra=[]){
  const result=await main(['fine','--stage',stage,'--project-root',f.f.projectRoot,'--from','solve','--output','evidence/'+output,...extra],
    {log:()=>{},executionOptions:{transport:f.f.transport,resolveWindow:async()=>f.f.options().windowId}});
  process.exitCode=0;return result;
}
test('preflight uses public apply checks, returns concrete source differences and never writes',async t=>{
  const f=await fineFixture(t),original=JSON.stringify(f.solved.candidate);
  const ready=await publicCall(f,'preflight','check');assert.equal(ready.status,'preflight-passed');assert.equal(ready.nextAction,'apply');
  assert.deepEqual(ready.commands,{public:1,windowDiscovery:1,nativeRequests:1});
  f.f.attributes[1].X+=5;f.f.attributes[1].bbox.minX+=5;f.f.attributes[1].bbox.maxX+=5;
  const drift=await publicCall(f,'preflight','drift');assert.equal(drift.status,'preflight-blocked');assert.equal(drift.native.error.code,'SOURCE_CHANGED_REPLAN');
  assert.equal(drift.sourceDifference.objects.items[0].ref,'U2');assert.ok(drift.sourceDifference.sourceRecords.added.length);
  assert.equal(JSON.stringify(f.solved.candidate),original);assert.equal(f.f.control.saves,0);assert.deepEqual(f.f.control.modifications,[]);
  assert.ok(drift.timing.edaSeconds>=0);assert.ok(drift.timing.preparationSeconds>=0);
});
test('project plus candidate directory resumes known save failure then only verifies a saved application',async t=>{
  const f=await fineFixture(t,{requiredRouting:true});await fs.mkdir(path.join(f.f.projectRoot,'evidence/route'),{recursive:true});
  await fs.writeFile(path.join(f.f.projectRoot,'evidence/route/fine-routing-receipt.json'),JSON.stringify(f.routingReceipt));
  f.f.control.saveResult=false;
  const first=await publicCall(f,'apply','first');assert.equal(first.status,'save-failed');
  const check=await publicCall(f,'preflight','unsaved');assert.equal(check.state.saved,false);assert.equal(check.nextAction,'resume-save');
  f.f.control.saveResult=true;
  const recovered=await publicCall(f,'apply','recover');assert.equal(recovered.status,'verified');assert.equal(recovered.state.saved,true);
  assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
  const saves=f.f.control.saves;
  const repeated=await publicCall(f,'apply','repeat');assert.equal(repeated.status,'verified');assert.equal(repeated.state.saved,true);
  assert.equal(f.f.control.saves,saves);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
});
test('saved readback failure stays saved; repeated normal entry never resaves',async t=>{
  const f=await fineFixture(t);f.f.control.afterSave=()=>{f.f.pads[1].Net='unexpected';};
  const first=await publicCall(f,'apply','first');assert.equal(first.status,'verify-after-save-failed');assert.equal(first.state.saved,true);
  const check=await publicCall(f,'preflight','check');assert.equal(check.status,'verification-failed');assert.equal(check.state.saved,true);
  const repeated=await publicCall(f,'apply','repeat');assert.equal(repeated.status,'verification-failed');assert.equal(repeated.state.saved,true);assert.equal(f.f.control.saves,1);
  assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
});
test('unknown target mutation blocks normal entry and preserves the pending claim',async t=>{
  const f=await fineFixture(t);f.f.control.beforePhase=({phase})=>{if(phase==='save')throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});};
  const first=await publicCall(f,'apply','first');assert.equal(first.status,'outcome-unknown');
  const marker=await fs.readFile(first.execution.saveAttemptFile,'utf8'),calls=f.f.calls.length;
  await assert.rejects(publicCall(f,'apply','repeat'),/FINE_TARGET_OUTCOME_UNKNOWN/);
  const check=await publicCall(f,'preflight','check');assert.equal(check.error.code,'FINE_TARGET_OUTCOME_UNKNOWN');
  assert.equal(f.f.calls.length,calls);assert.equal(await fs.readFile(first.execution.saveAttemptFile,'utf8'),marker);
});
test('geometry matching without a receipt never establishes applied or saved state',async t=>{
  const f=await fineFixture(t,{moveMil:0});
  const check=await publicCall(f,'preflight','check');assert.equal(check.state.saved,null);assert.equal(check.state.native,'unconfirmed');assert.equal(f.f.control.saves,0);
});
test('wrong live target and new native lock block read-only preflight',async t=>{
  for(const mode of ['target','lock']){
    const f=await fineFixture(t);if(mode==='target')f.f.control.document.uuid='other';else f.f.components[0].PrimitiveLock=true;
    const check=await publicCall(f,'preflight','check');assert.equal(check.status,'preflight-blocked');assert.equal(f.f.control.saves,0);assert.deepEqual(f.f.control.modifications,[]);
  }
});
test('candidate engine/input changes cannot be refreshed by preflight',async t=>{
  const f=await fineFixture(t),input=structuredClone(f.input);input.result.source.engine.implementationHash='stale';
  await assert.rejects(preflightFineLayout({...input,options:f.f.options()}),/FINE_ENGINE_CHANGED/);
  assert.equal(f.f.control.saves,0);
});

test('post-save source drift returns available differences and preserves the confirmed save',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first');assert.equal(first.state.saved,true);
  f.f.attributes[1].X+=5;f.f.attributes[1].bbox.minX+=5;f.f.attributes[1].bbox.maxX+=5;
  const check=await publicCall(f,'preflight','drift');assert.equal(check.status,'verification-failed');assert.equal(check.state.saved,true);
  assert.ok(check.sourceDifference.objects.items.some(l=>l.ref==='U2'));assert.equal(check.commands.nativeRequests,2);
  assert.equal(f.f.control.saves,1);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
});

test('historical acceptance binding conflict is explicit and does not erase a saved core receipt',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first'),receiptFile=first.execution.resumeSaveReport;
  const receipt=JSON.parse(await fs.readFile(receiptFile,'utf8')),workflow=JSON.parse(await fs.readFile(first.execution.reportFile,'utf8'));
  receipt.acceptanceEvidence.engineHash='historical-engine';
  // Model a self-consistent historical core receipt with a different fine binding.
  const {digest}=await import('../scripts/pcb-layout/fine/common.mjs');workflow.receiptHash=digest(receipt);
  await fs.writeFile(receiptFile,JSON.stringify(receipt));await fs.writeFile(first.execution.reportFile,JSON.stringify(workflow));
  const check=await publicCall(f,'preflight','historical');assert.equal(check.error.code,'FINE_APPLICATION_EVIDENCE_CHANGED');
  assert.equal(check.conflict.field,'engineHash');assert.equal(check.conflict.actual,'historical-engine');assert.equal(check.state.saved,true);
  assert.equal(check.commands.nativeRequests,0);assert.equal(f.f.control.saves,1);
});


test('a genuinely older candidate implementation preserves independently confirmed saving',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first');assert.equal(first.state.saved,true);
  const {digest}=await import('../scripts/pcb-layout/fine/common.mjs');
  const resultFile=path.join(f.solveDirectory,'result.json'),manifestFile=path.join(f.solveDirectory,'manifest.json');
  const result=JSON.parse(await fs.readFile(resultFile)),manifest=JSON.parse(await fs.readFile(manifestFile));
  result.source.engine.implementationHash='older-implementation';manifest.resultHash=digest(result);manifest.source=result.source;
  await fs.writeFile(resultFile,JSON.stringify(result));await fs.writeFile(manifestFile,JSON.stringify(manifest));
  const check=await publicCall(f,'preflight','older');
  assert.equal(check.error.code,'FINE_ENGINE_CHANGED');assert.equal(check.state.saved,true);
  assert.equal(check.state.verified,false);assert.equal(check.conflict.actual.implementationHash,'older-implementation');
  assert.equal(check.commands.nativeRequests,0);assert.equal(f.f.control.saves,1);
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/pcb-layout.mjs',import.meta.url)),'fine','--stage','apply',
    '--project-root',f.f.projectRoot,'--from','solve','--window-id','window','--receipt',first.execution.resumeSaveReport,'--output','evidence/older-apply'],{encoding:'utf8'});
  assert.equal(cli.status,1);const failure=JSON.parse(cli.stderr.trim());
  assert.equal(failure.error.code,'FINE_ENGINE_CHANGED');assert.equal(failure.state.saved,true);assert.equal(failure.state.verified,false);
});

test('unreadable history identifies its file; explicit receipt permits read-only checking without a history scan',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first');
  const bad=path.join(f.f.projectRoot,'evidence/unrelated/layout-execution-result.json');await fs.mkdir(path.dirname(bad),{recursive:true});await fs.writeFile(bad,'{');
  const blocked=await publicCall(f,'preflight','blocked');assert.equal(blocked.error.code,'FINE_HISTORY_UNREADABLE');assert.ok(blocked.error.message.includes(bad));
  const checked=await publicCall(f,'preflight','explicit',['--receipt',first.execution.resumeSaveReport]);
  assert.equal(checked.status,'verified');assert.equal(checked.state.saved,true);assert.equal(f.f.control.saves,1);
});

test('normal application computes the candidate implementation closure once',async t=>{
  const f=await fineFixture(t),original=fs.readFile;let reads=0;
  t.mock.method(fs,'readFile',async function(file,...rest){if(String(file).replaceAll('\\','/').endsWith('/scripts/pcb-layout/pcb-layout-search.mjs'))reads++;return original.call(this,file,...rest);});
  const first=await publicCall(f,'apply','first');assert.equal(first.status,'verified');assert.equal(reads,1);
});

test('session discovery failures still produce a structured preflight report',async t=>{
  const f=await fineFixture(t);
  const result=await main(['fine','--stage','preflight','--project-root',f.f.projectRoot,'--from','solve','--output','evidence/no-session'],
    {log:()=>{},executionOptions:{resolveWindow:async()=>{throw Object.assign(Error('No unique session'),{code:'LAYOUT_TARGET_SESSION_REQUIRED'});}}});
  process.exitCode=0;assert.equal(result.error.code,'LAYOUT_TARGET_SESSION_REQUIRED');assert.equal(result.commands.nativeRequests,0);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.f.projectRoot,'evidence/no-session/preflight.json'))).error.code,'LAYOUT_TARGET_SESSION_REQUIRED');
});


test('changed project rules block preflight while retaining the historical save fact',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first');
  const file=path.join(f.f.projectRoot,'design/mechanical.json'),mechanical=JSON.parse(await fs.readFile(file));
  mechanical.clearanceMil+=1;await fs.writeFile(file,JSON.stringify(mechanical));
  const checked=await publicCall(f,'preflight','changed',['--receipt',first.execution.resumeSaveReport]);
  assert.equal(checked.error.code,'FINE_PROJECT_INPUTS_CHANGED');assert.equal(checked.state.saved,true);
  assert.equal(checked.state.verified,false);assert.equal(checked.commands.nativeRequests,0);assert.equal(f.f.control.saves,1);
});
