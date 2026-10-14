import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fineFixture} from '../helpers/pcb-fine-recovery-fixture.mjs';
import {main} from '../../scripts/pcb-layout.mjs';
import {preflightFineLayout} from '../../scripts/pcb-layout/fine/workflow.mjs';

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
  const drift=await publicCall(f,'preflight','drift');assert.equal(drift.status,'preflight-passed');assert.equal(drift.nextAction,'apply');
  assert.ok(drift.native.geometry.preservedChanges.some(l=>l.id===f.f.attributes[1].PrimitiveId));
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
  const {digest}=await import('../../scripts/pcb-layout/fine/common.mjs');workflow.receiptHash=digest(receipt);
  await fs.writeFile(receiptFile,JSON.stringify(receipt));await fs.writeFile(first.execution.reportFile,JSON.stringify(workflow));
  const check=await publicCall(f,'preflight','historical');assert.equal(check.error.code,'FINE_APPLICATION_EVIDENCE_CHANGED');
  assert.equal(check.conflict.field,'engineHash');assert.equal(check.conflict.actual,'historical-engine');assert.equal(check.state.saved,true);
  assert.equal(check.commands.nativeRequests,0);assert.equal(f.f.control.saves,1);
});


test('a genuinely older candidate implementation preserves independently confirmed saving',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first');assert.equal(first.state.saved,true);
  const {digest}=await import('../../scripts/pcb-layout/fine/common.mjs');
  const resultFile=path.join(f.solveDirectory,'result.json'),manifestFile=path.join(f.solveDirectory,'manifest.json');
  const result=JSON.parse(await fs.readFile(resultFile)),manifest=JSON.parse(await fs.readFile(manifestFile));
  result.source.engine.implementationHash='older-implementation';manifest.resultHash=digest(result);manifest.source=result.source;
  await fs.writeFile(resultFile,JSON.stringify(result));await fs.writeFile(manifestFile,JSON.stringify(manifest));
  const check=await publicCall(f,'preflight','older');
  assert.equal(check.error.code,'FINE_ENGINE_CHANGED');assert.equal(check.state.saved,true);
  assert.equal(check.state.verified,false);assert.equal(check.conflict.actual.implementationHash,'older-implementation');
  assert.equal(check.commands.nativeRequests,0);assert.equal(f.f.control.saves,1);
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/pcb-layout.mjs',import.meta.url)),'fine','--stage','apply',
    '--project-root',f.f.projectRoot,'--from','solve','--window-id','window','--receipt',first.execution.resumeSaveReport,'--output','evidence/older-apply'],{encoding:'utf8',timeout:30000});
  assert.equal(cli.status,1);const failure=JSON.parse(cli.stderr.trim());
  assert.equal(failure.error.code,'FINE_ENGINE_CHANGED');assert.equal(failure.state.saved,true);assert.equal(failure.state.verified,false);
});

test('unreadable history identifies its file; explicit receipt permits read-only checking without a history scan',async t=>{
  const f=await fineFixture(t),first=await publicCall(f,'apply','first');
  const bad=path.join(f.f.projectRoot,'evidence/unrelated/layout-execution-result.json');await fs.mkdir(path.dirname(bad),{recursive:true});await fs.writeFile(bad,'{');
  const blocked=await publicCall(f,'preflight','blocked');assert.equal(blocked.error.code,'FINE_HISTORY_UNREADABLE');assert.ok(blocked.error.message.includes(await fs.realpath(bad)));
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

const outsideLabel=f=>{const l=f.attributes[1];l.X=-20;l.bbox={minX:-24,maxX:-16,minY:109,maxY:111};};
const retainOutside=r=>{r.baselinePolicy='retain-outside-issues';};
test('local retained baseline passes the actual native preflight/apply/save/readback chain',async t=>{
 const f=await fineFixture(t,{configureNative:outsideLabel,configureRequest:retainOutside});
 assert.equal(f.solved.candidate.audit.nativeEligible,true);assert.equal(f.solved.candidate.audit.wholeBoardAccepted,false);
 const pre=await publicCall(f,'preflight','local-check');assert.equal(pre.status,'preflight-passed',JSON.stringify(pre));assert.ok(pre.native.geometry.retainedOutsideIssues.length);assert.deepEqual(f.f.control.modifications,[]);
 const applied=await publicCall(f,'apply','local-apply');assert.equal(applied.status,'verified',JSON.stringify(applied));assert.equal(applied.state.saved,true);assert.ok(applied.execution.verification.retainedOutsideIssues.length);assert.equal(applied.execution.verification.wholeBoardAccepted,false);
 const saves=f.f.control.saves;const repeated=await publicCall(f,'apply','local-repeat');assert.equal(repeated.status,'verified');assert.equal(repeated.state.saved,true);assert.equal(f.f.control.saves,saves);assert.equal(f.f.calls.filter(p=>p==='apply').length,1);
});
test('retained outside edits are accepted before writing; post-save changes remain failed readback',async t=>{
 const f=await fineFixture(t,{configureNative:outsideLabel,configureRequest:retainOutside});
 f.f.attributes[1].bbox.minX-=1;const pre=await publicCall(f,'preflight','local-drift');assert.equal(pre.status,'preflight-passed');assert.ok(pre.native.geometry.preservedChanges.length);assert.deepEqual(f.f.control.modifications,[]);
 const g=await fineFixture(t,{configureNative:outsideLabel,configureRequest:retainOutside});g.f.control.afterSave=()=>{g.f.attributes[1].bbox.minX-=1;};
 const applied=await publicCall(g,'apply','local-worse');assert.equal(applied.state.saved,true);assert.equal(applied.status,'verify-after-save-failed');assert.equal(applied.state.verified,false);assert.ok(applied.execution.steps.at(-1).status!=='verified');
});
test('a retained baseline does not relax unknown transaction recovery',async t=>{
 const f=await fineFixture(t,{configureNative:outsideLabel,configureRequest:retainOutside});f.f.control.beforePhase=({phase})=>{if(phase==='save')throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});};
 const first=await publicCall(f,'apply','local-unknown');assert.equal(first.status,'outcome-unknown');const marker=await fs.readFile(first.execution.saveAttemptFile,'utf8'),calls=f.f.calls.length;
 await assert.rejects(publicCall(f,'apply','local-unknown-repeat'),/FINE_TARGET_OUTCOME_UNKNOWN/);assert.equal(f.f.calls.length,calls);assert.equal(await fs.readFile(first.execution.saveAttemptFile,'utf8'),marker);
});

test('a moving body colliding with an unchanged outside label fails before native dispatch',async t=>{
 const f=await fineFixture(t,{expectedStatus:'candidate-rejected',configureRequest:retainOutside,configureNative:f=>{const l=f.attributes[1];l.X=170;l.Y=100;l.bbox={minX:166,maxX:174,minY:99,maxY:101};}});
 assert.equal(f.solved.candidate.audit.localAccepted,false);assert.ok(f.solved.candidate.audit.blockingIssues.some(i=>i.code==='FINE_LABEL_BODY_GAP'&&i.ref==='U1'));
 const calls=f.f.calls.length;await assert.rejects(preflightFineLayout({...f.input,options:f.f.options()}),/FINE_COMPLETE_CANDIDATE_REQUIRED/);assert.equal(f.f.calls.length,calls);assert.deepEqual(f.f.control.modifications,[]);
});

test('an unrelated outside designator edit applies only the original differences and survives saving',async t=>{
 const f=await fineFixture(t),candidate=JSON.stringify(f.solved.candidate),oldHash=f.inputs.snapshot.sourceHash;
 f.f.attributes[1].X+=5;f.f.attributes[1].bbox.minX+=5;f.f.attributes[1].bbox.maxX+=5;f.f.attributes[1].DisplayOrder=7;
 const expected={x:f.f.attributes[1].X,bbox:{...f.f.attributes[1].bbox},order:7};
 const checked=await publicCall(f,'preflight','outside-pre');assert.equal(checked.status,'preflight-passed');assert.equal(checked.commands.nativeRequests,1);
 const applied=await publicCall(f,'apply','outside-apply');assert.equal(applied.status,'verified',JSON.stringify(applied.execution.error));assert.equal(applied.state.saved,true);
 assert.equal(JSON.stringify(f.solved.candidate),candidate);assert.equal(f.solved.candidate.plan.sourceHash,oldHash);
 assert.equal(f.f.attributes[1].X,expected.x);assert.deepEqual(f.f.attributes[1].bbox,expected.bbox);assert.equal(f.f.attributes[1].DisplayOrder,expected.order);
 assert.ok(applied.preservedChanges.some(c=>c.id===f.f.attributes[1].PrimitiveId&&c.fields.includes('DisplayOrder')));
 assert.deepEqual(f.f.control.modifications,[f.f.components[0].PrimitiveId,f.f.attributes[0].PrimitiveId]);
 const receipt=JSON.parse(await fs.readFile(applied.execution.resumeSaveReport));
 assert.equal(receipt.snapshot.sourceHash,oldHash);assert.notEqual(receipt.writeBaseline.sourceHash,oldHash);assert.equal(receipt.writeBaseline.items[1].original.x,expected.x);
 const count=f.f.calls.length,readback=await publicCall(f,'apply','outside-repeat');assert.equal(readback.status,'verified');assert.deepEqual(f.f.calls.slice(count),['verify']);assert.equal(f.f.control.saves,1);
});

for(const change of ['pose','footprint','pad-shape','pad-net','pad-lock','label-pose','label-format','label-metadata','native-rule'])test('affected '+change+' rejects the candidate before any write',async t=>{
 const f=await fineFixture(t);
 if(change==='pose')f.f.components[0].X+=1;
 if(change==='footprint')f.f.components[0].Footprint.name='DIFFERENT';
 if(change==='pad-shape')f.f.pads[0].Pad=['RECT',6,4];
 if(change==='pad-net')f.f.pads[2].Net='changed-related-net';
 if(change==='pad-lock')f.f.pads[0].PrimitiveLock=true;
 if(change==='label-pose')f.f.attributes[0].X+=1;
 if(change==='label-format')f.f.attributes[0].FontSize+=1;
 if(change==='label-metadata')f.f.attributes[0].DisplayOrder=2;
 if(change==='native-rule')f.f.control.sourceRecords=[JSON.stringify({type:'RULE',id:'clearance'})+'||'+JSON.stringify({clearanceMil:20})+'|'];
 const pre=await publicCall(f,'preflight','conflict-pre');assert.equal(pre.status,'preflight-blocked',change);
 const applied=await publicCall(f,'apply','conflict-apply');assert.equal(applied.status,'preflight-failed',change);assert.equal(applied.execution.applyState,'not-started');assert.equal(f.f.control.saves,0);assert.deepEqual(f.f.control.modifications,[]);
});

test('a changed outside label entering the required target gap rejects with zero writes',async t=>{
 const f=await fineFixture(t),l=f.f.attributes[1];l.X=170;l.Y=100;l.bbox={minX:166,maxX:174,minY:99,maxY:101};
 const pre=await publicCall(f,'preflight','collision-pre');assert.equal(pre.status,'preflight-blocked');assert.match(pre.native.error.message,/FINE_LABEL_BODY_GAP/);
 const applied=await publicCall(f,'apply','collision-apply');assert.equal(applied.status,'preflight-failed');assert.equal(f.f.control.saves,0);assert.deepEqual(f.f.control.modifications,[]);
});

test('current external geometry is checked by the existing spatial rules before native apply',async t=>{
 const f=await fineFixture(t,{configureRequest:r=>{delete r.fixedRefs;}}),c=f.f.components[1],pad=f.f.pads[1],l=f.f.attributes[1];
 const dx=-275;for(const a of [c,pad,l]){a.X+=dx;a.bbox.minX+=dx;a.bbox.maxX+=dx;}
 const pre=await publicCall(f,'preflight','body-gap-pre');assert.equal(pre.status,'preflight-blocked');assert.match(pre.native.error.message,/BUNDLE_CLEARANCE/);
 assert.deepEqual(f.f.control.modifications,[]);assert.equal(f.f.control.saves,0);
});

test('an otherwise harmless edit between preflight and apply stops before the first mutation',async t=>{
 const f=await fineFixture(t);f.f.control.beforePhase=({phase})=>{if(phase==='apply')f.f.attributes[1].DisplayOrder=8;};
 const result=await publicCall(f,'apply','preflight-race');assert.equal(result.status,'apply-failed');assert.match(result.execution.error.message,/SOURCE_CHANGED_AFTER_PREFLIGHT/);
 assert.deepEqual(f.f.control.modifications,[]);assert.equal(f.f.control.saves,0);
});

test('live acceptance keeps the original candidate relation comparison distances',async t=>{
 const f=await fineFixture(t,{configureRequest:r=>{r.relations=[{id:'reach-testpoint',from:{ref:'U1',pin:'1'},to:{padId:'testpad'},basis:'synthetic original distance comparison',weight:1,nonRegression:{toleranceMil:0}}];}});
 f.f.attributes[1].X+=5;f.f.attributes[1].bbox.minX+=5;f.f.attributes[1].bbox.maxX+=5;
 const pre=await publicCall(f,'preflight','relation-baseline');assert.equal(pre.status,'preflight-passed');
 assert.equal(pre.native.audit.relations[0].beforeMil,f.solved.candidate.audit.relations[0].beforeMil);assert.equal(pre.native.audit.relations[0].beforeMil,500);
 assert.equal(pre.native.audit.relations[0].afterMil,480);assert.equal(pre.native.audit.relations[0].passed,true);assert.deepEqual(f.f.control.modifications,[]);
});

test('public fine applies a harmless new silk through all four stages and rejects an obstructing one on the same model',async t=>{
 for(const obstructing of [false,true]){
  const f=await fineFixture(t),x=obstructing?170:800,y=obstructing?100:200;
  f.f.strings.push(f.f.primitive({PrimitiveId:'manual-silk',Layer:3,Text:'external note',X:x,Y:y,bbox:{minX:x-5,maxX:x+5,minY:y-1,maxY:y+1}}));
  const calls=f.f.calls.length,result=await publicCall(f,'apply',obstructing?'silk-blocked':'silk-saved');
  if(obstructing){assert.equal(result.status,'preflight-failed');assert.match(result.execution.error.message,/LAYOUT_OBSTACLE_GAP/);assert.deepEqual(f.f.calls.slice(calls),['preflight']);assert.deepEqual(f.f.control.modifications,[]);assert.equal(f.f.control.saves,0);}
  else{assert.equal(result.status,'verified',result.execution.error?.message);assert.equal(result.state.saved,true);assert.deepEqual(f.f.calls.slice(calls),['preflight','apply','verify','save','verify']);assert.equal(f.f.strings[0].Text,'external note');assert.equal(f.f.strings[0].X,x);assert.ok(result.preservedChanges.some(c=>c.id==='manual-silk'&&c.change==='added'));assert.ok(result.execution.verification.writeBaseline.obstacles.some(c=>c.id==='manual-silk'));assert.equal(f.f.control.modifications.includes('manual-silk'),false);assert.equal(f.f.control.saves,1);}
 }
});

for (const sameTarget of [false,true]) test('damaged history with '+(sameTarget?'matching':'different')+' document input is scoped by identity', async t=>{
 const f=await fineFixture(t), first=await publicCall(f,'apply','history-source');
 const directory=path.join(f.f.projectRoot,'evidence/damaged');await fs.mkdir(directory,{recursive:true});
 const source=JSON.parse(await fs.readFile(path.join(path.dirname(first.execution.reportFile),'layout-apply-input.json'),'utf8'));
 if(!sameTarget)source.config.expectedDocumentUuid+='-other';
 await fs.writeFile(path.join(directory,'layout-apply-input.json'),JSON.stringify(source));
 await fs.writeFile(path.join(directory,'layout-execution-result.json'),'{');
 const result=await publicCall(f,'preflight','history-check');
 if(sameTarget)assert.equal(result.error.code,'FINE_HISTORY_UNREADABLE');
 else {assert.equal(result.status,'verified');assert.equal(result.state.saved,true);}
 assert.equal(f.f.control.saves,1);
});
