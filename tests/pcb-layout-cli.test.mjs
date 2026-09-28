import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { prepareFixture, filterRelation, addIntent } from './helpers/pcb-layout-prepare-fixture.mjs';

const cli=fileURLToPath(new URL('../scripts/pcb-layout.mjs',import.meta.url)),exec=promisify(execFile);
async function project() {
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'layout-portable-')));
  const f=addIntent(prepareFixture(),filterRelation());
  f.snapshot.sourceKind='synthetic-example';
  f.config.contractFile='design/contract.json';f.config.mechanicalRulesFile='design/mechanical.json';
  f.config.search.profiles=[{name:'balanced',label:'Balanced',seed:31,weightMultipliers:{}}];
  f.config.search.iterations=2;f.config.initialization={mode:'existing',count:1,seed:31,explorationStrength:0,packingGapMil:10,attemptsPerStart:1,maxRepairMil:100};
  await fs.mkdir(path.join(root,'design'));
  for(const [name,data] of [['design/PCB_LAYOUT_CONSTRAINTS.v1.json',f.config],['design/contract.json',f.contract],['design/mechanical.json',f.mechanical],['snapshot.json',f.snapshot]])await fs.writeFile(path.join(root,name),JSON.stringify(data));
  return root;
}
async function run(root,args) {
  try {const r=await exec(process.execPath,[cli,'--project-root',root,...args],{cwd:tmpdir(),maxBuffer:2*1024*1024});return{ok:true,lines:r.stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)),stderr:r.stderr};}
  catch(e){return{ok:false,stderr:e.stderr,stdout:e.stdout};}
}

test('portable CLI prepares immutable complete inputs and replays them without the original design files',async()=>{
  const root=await project();
  try {
    const first=await run(root,['--snapshot',path.join(root,'snapshot.json')]);assert.ok(first.ok,first.stderr);
    const a=first.lines.at(-1);assert.equal(a.status,'inputs-ready');assert.equal(a.nativeWrites,0);assert.equal(a.counts.components,2);
    const manifest=JSON.parse(await fs.readFile(path.join(a.report,'manifest.json')));assert.ok(manifest.engine.implementationHash);assert.ok(manifest.inputsHash);
    await fs.rename(path.join(root,'design'),path.join(root,'design-offline'));
    const second=await run(root,['--prepared',a.report]);assert.ok(second.ok,second.stderr);
    const b=second.lines.at(-1);assert.equal(b.source,'prepared-snapshot');assert.deepEqual(b.currentLayout,a.currentLayout);
    const packet=path.join(a.report,'inputs.json');const data=JSON.parse(await fs.readFile(packet));data.snapshot.components[0].x+=1;await fs.writeFile(packet,JSON.stringify(data));
    const changed=await run(root,['--prepared',a.report]);assert.equal(changed.ok,false);assert.match(changed.stderr,/PREPARED_INPUT_CHANGED/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('solve consumes compiled upstream relationships and emits version-bound candidates without EDA',async()=>{
  const root=await project();
  try {
    const r=await run(root,['--mode','solve','--snapshot',path.join(root,'snapshot.json'),'--start-mode','existing','--starts','1','--iterations','2']);assert.ok(r.ok,r.stderr);
    const result=r.lines.at(-1);assert.equal(result.status,'candidates-ready-not-applied');
    const manifest=JSON.parse(await fs.readFile(path.join(result.report,'manifest.json')));assert.equal(manifest.schemaVersion,3);assert.ok(manifest.candidates.length>=2);assert.ok(manifest.inputsHash);
    for (const record of manifest.candidates) {
      const bytes = await fs.readFile(path.join(result.report, record.name + '.json'));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    }
    const candidate=JSON.parse(await fs.readFile(path.join(result.report,manifest.candidates.find(x=>x.name!=='baseline').name+'.json')));assert.equal(candidate.validation.valid,true);assert.ok(candidate.metrics.details.length>0);
    const report=await fs.readFile(path.join(result.report,'comparison.html'),'utf8');assert.match(report,/<title>PCB /);assert.ok(!/[A-Za-z]:[\\/]/.test(report));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('catalog uses the configured pool grid and emits verifiable candidates through the same CLI', async () => {
  const root = await project();
  try {
    const configFile = path.join(root, 'design/PCB_LAYOUT_CONSTRAINTS.v1.json');
    const config = JSON.parse(await fs.readFile(configFile));
    config.search.catalogGridMil = 9;
    await fs.writeFile(configFile, JSON.stringify(config));
    const args = ['--mode', 'solve', '--snapshot', path.join(root, 'snapshot.json'), '--iterations', '16', '--catalog-count', '1'];
    const result = await run(root, args);
    assert.ok(result.ok, result.stderr);
    const output = result.lines.at(-1);
    assert.equal(output.status, 'catalog-ready-not-applied');
    const manifest = JSON.parse(await fs.readFile(path.join(output.report, 'manifest.json')));
    const parameters = JSON.parse(await fs.readFile(path.join(output.report, 'run-parameters.json')));
    assert.equal(manifest.projectRoot, root);
    assert.equal(manifest.candidates.length, 1);
    assert.ok(manifest.inputsHash);
    assert.equal(parameters.poolGridMil, 9);
    for (const record of manifest.candidates) {
      const bytes = await fs.readFile(path.join(output.report, record.name + '.json'));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
      const candidate = JSON.parse(bytes);
      assert.equal(candidate.validation.valid, true);
      assert.ok(Number.isFinite(candidate.scores.total));
      assert.ok(candidate.metrics.details.length > 0);
    }
    config.search.catalogGridMil = -1;
    await fs.writeFile(configFile, JSON.stringify(config));
    const invalid = await run(root, args);
    assert.equal(invalid.ok, false);
    assert.match(invalid.stderr, /INVALID_CATALOG_GRID/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepare never accepts search or write flags implicitly',async()=>{
  const root=await project();
  try {
    for(const args of [['--iterations','1'],['--from','somewhere','--candidate','example'],['--mode','refine']]){
      const r=await run(root,['--snapshot',path.join(root,'snapshot.json'),...args]);assert.equal(r.ok,false);assert.match(r.stderr,/REQUIRE|INVALID_LAYOUT_MODE/);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('save recovery rejects changed frozen inputs and new rule overrides before contacting EDA',async()=>{
  const root=await project();
  try {
    const r=await run(root,['--snapshot',path.join(root,'snapshot.json')]);assert.ok(r.ok,r.stderr);
    const report=r.lines.at(-1).report,bundle=JSON.parse(await fs.readFile(path.join(report,'inputs.json')));
    const receipt=path.join(report,'layout-apply-receipt.json');
    await fs.writeFile(receipt,JSON.stringify({kind:'flitrealize.pcb-layout.apply-receipt',projectRoot:root,workflowFile:path.join(report,'layout-execution-result.json'),snapshot:bundle.snapshot}));
    const overridden=await run(root,['--mode','apply','--window-id','unavailable','--resume-save',receipt,'--weight','power=2']);
    assert.equal(overridden.ok,false);assert.match(overridden.stderr,/RECOVERY_INPUTS_ARE_FROZEN/);
    bundle.config.hard.fixed=[];bundle.snapshot.components[0].x+=1;await fs.writeFile(path.join(report,'inputs.json'),JSON.stringify(bundle));
    const changed=await run(root,['--mode','apply','--window-id','unavailable','--resume-save',receipt]);
    assert.equal(changed.ok,false);assert.match(changed.stderr,/RECOVERY_INPUT_CHANGED/);
    const names=await fs.readdir(report);assert.ok(!names.includes('layout-save.js'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('provided ownership can be inspected but a new real solve requires verified native readback',async()=>{
  const root=await project();
  try {
    const file=path.join(root,'snapshot.json'),snapshot=JSON.parse(await fs.readFile(file));
    delete snapshot.sourceKind;await fs.writeFile(file,JSON.stringify(snapshot));
    const inspected=await run(root,['--snapshot',file]);assert.ok(inspected.ok,inspected.stderr);
    assert.equal(inspected.lines.at(-1).nativeChecks.ownership,'provided');
    const solve=await run(root,['--mode','solve','--snapshot',file,'--starts','1','--iterations','1']);
    assert.equal(solve.ok,false);assert.match(solve.stderr,/REFRESH_NATIVE_OWNERSHIP/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
