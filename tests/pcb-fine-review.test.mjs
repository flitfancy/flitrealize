import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { reviewFineLayout } from '../scripts/pcb-layout/pcb-layout-fine-review.mjs';

const box = (x,y,w=50,h=30) => ({minX:x-w/2,minY:y-h/2,maxX:x+w/2,maxY:y+h/2});
function fixture() {
  const components=[['A',100,100],['B',400,100],['C',800,600]].map(([ref,x,y])=>({id:'component-'+ref,ref,x,y,rotation:0,layer:1,locked:false,bbox:box(x,y),footprint:{name:'FP'}}));
  const pads=components.flatMap(c=>[-20,20].map((dx,i)=>({id:c.id+'-pin-'+(i+1),owner:c.ref,parentComponentId:c.id,number:String(i+1),net:i===0?'N':'GND',layer:1,x:c.x+dx,y:c.y,bbox:box(c.x+dx,c.y,12,12)})));
  pads.push({id:'standalone',owner:null,parentComponentId:null,number:'TP1',net:'TEST',x:550,y:550,layer:1,bbox:box(550,550,20,20)});
  return {status:'inspected',sourceHash:123,units:'mil',coordinateSystem:'eda-y-up',provider:'easyeda-pro',document:{uuid:'pcb',parentProjectUuid:'project'},components,pads,items:[],regions:[],routing:{Line:0,Arc:0,Polyline:0,Via:0,Pour:0},outlines:[{id:'outline',path:[0,0,'L',1000,0,1000,800,0,800,0,0]}]};
}
function request() {
  return {schemaVersion:1,expectedSourceHash:123,movableDesignators:['A'],planInput:{mode:'plan',expectedProjectUuid:'project',expectedDocumentUuid:'pcb',lockedDesignators:['C'],reservedRegions:[],clearanceMil:8,scenarios:[{name:'shift',placements:[{designator:'A',x:150,y:100}]}]},audit:{nets:['N'],padPairs:[{id:'local-sense',net:'N',a:{ref:'A',pad:'1'},b:{ref:'B',pad:'1'}}]}};
}
test('fine review preserves untouched objects and audits every specified net pad',()=>{
  const s=fixture(),r=request(),before=structuredClone({s,r}),out=reviewFineLayout(s,r),c=out.candidates[0];
  assert.equal(out.status,'reviewed');assert.equal(out.nativeWrites,0);assert.deepEqual({s,r},before);
  assert.equal(c.changes.length,1);assert.equal(c.issues.length,0);
  assert.equal(c.metrics.padPairs[0].beforeMil,300);assert.equal(c.metrics.padPairs[0].afterMil,250);
  // Net N includes C as well, so HPWL observes the cross-block effect.
  assert.equal(c.metrics.nets[0].beforeMil,1200);assert.equal(c.metrics.nets[0].afterMil,1150);
  assert.deepEqual(c.geometry.pads.find(p=>p.id==='standalone').bbox,s.pads.at(-1).bbox);
  assert.deepEqual(c.geometry.components.find(x=>x.ref==='B').bbox,s.components[1].bbox);
  assert.deepEqual(c.placementPlanRequest.lockedDesignators.sort(),['B','C']);
  assert.equal(out.coverage.assembly,'not-checked');
});
test('rotations use observed owned pad offsets and omitted angles preserve the original',()=>{
  const s=fixture(),r=request();r.planInput.scenarios[0].placements[0].rotation=90;
  const c=reviewFineLayout(s,r).candidates[0],p=c.geometry.pads.find(p=>p.owner==='A'&&p.number==='1');
  assert.equal(p.x,150);assert.equal(p.y,80);
  assert.equal(c.metrics.padPairs[0].afterMil,Math.hypot(230,20));
  s.components[0].rotation=90;delete r.planInput.scenarios[0].placements[0].rotation;
  assert.equal(reviewFineLayout(s,r).candidates[0].changes[0].rotation,90);
});
test('fixed and native-locked components stay unavailable for the movement executor',()=>{
  for(const kind of ['scope','explicit','native']){
    const s=fixture(),r=request();
    if(kind==='scope')r.movableDesignators=[];
    if(kind==='explicit')r.planInput.lockedDesignators.push('A');
    if(kind==='native')s.components[0].locked=true;
    const c=reviewFineLayout(s,r).candidates[0];
    assert.ok(c.issues.some(i=>i.code==='FIXED_COMPONENT_CHANGED'));assert.equal(c.placementPlanRequest,null);
  }
});
test('missing board returns a creation request only for explicit dimensions; existing board is reused',()=>{
  const s=fixture(),r=request();s.outlines=[];
  let out=reviewFineLayout(s,r);assert.equal(out.status,'board-outline-required');assert.equal(out.boardOutlineRequest,null);assert.deepEqual(out.candidates,[]);
  r.planInput.boardBounds={minX:-10,minY:-20,maxX:1000,maxY:800};
  out=reviewFineLayout(s,r);assert.deepEqual(out.boardOutlineRequest.rect,{originX:-10,originY:-20,widthMil:1010,heightMil:820});assert.equal(out.boardOutlineRequest.replace,undefined);
  assert.throws(()=>reviewFineLayout(fixture(),r),/BOARD_BOUNDS_MISMATCH/);
  delete r.planInput.boardBounds;out=reviewFineLayout(fixture(),r);assert.equal(out.boardOutlineRequest,undefined);assert.deepEqual(out.board.sources,['native']);
  s.outlines=[{id:'irregular',path:[0,0,'L',1000,0,800,800,0,800,0,0]}];
  assert.throws(()=>reviewFineLayout(s,r),/BOARD_OUTLINE_UNSUPPORTED/);
});
test('existing copper permits hypothetical comparison but exposes the actual executor limitation',()=>{
  const s=fixture(),r=request();s.routing.Line=7;
  const c=reviewFineLayout(s,r).candidates[0];assert.equal(c.metrics.padPairs[0].deltaMil,-50);assert.equal(c.issues.length,0);
  assert.equal(c.executionIssues[0].code,'EXECUTOR_REQUIRES_UNROUTED_BOARD');assert.equal(c.placementPlanRequest,null);
});
test('proposals report new board, clearance and pair-limit problems without hiding the baseline',()=>{
  const s=fixture(),r=request();s.components[2].bbox=box(1010,600);r.planInput.scenarios[0].placements[0].x=400;
  r.audit.padPairs[0].maxDistanceMil=1;
  const out=reviewFineLayout(s,r),c=out.candidates[0];
  assert.ok(out.baseline.issues.some(i=>i.code==='BOARD_BOUNDARY_VIOLATION'));
  assert.ok(c.issues.some(i=>i.code==='BOARD_BOUNDARY_VIOLATION'));
  assert.ok(c.introducedIssues.some(i=>i.code==='PHYSICAL_ENVELOPE_CLEARANCE'));
  assert.equal(c.placementPlanRequest,null);
  r.planInput.scenarios[0].placements[0].x=150;
  assert.ok(reviewFineLayout(fixture(),r).candidates[0].issues.some(i=>i.code==='PAD_PAIR_DISTANCE'));
});
test('an existing pair-distance violation is tracked as existing or resolved, not newly introduced',()=>{
  const s=fixture(),r=request();r.audit.padPairs[0].maxDistanceMil=280;
  let out=reviewFineLayout(s,r);
  assert.ok(out.baseline.issues.some(i=>i.code==='PAD_PAIR_DISTANCE'));
  assert.ok(out.candidates[0].resolvedIssues.some(i=>i.code==='PAD_PAIR_DISTANCE'));
  r.planInput.scenarios[0].placements=[];out=reviewFineLayout(s,r);
  assert.ok(out.candidates[0].issues.some(i=>i.code==='PAD_PAIR_DISTANCE'));
  assert.equal(out.candidates[0].introducedIssues.length,0);
});
test('group transforms preserve relative geometry and reject duplicate assignment',()=>{
  const s=fixture(),r=request();r.movableDesignators=['A','B'];r.planInput.scenarios=[{name:'group',groups:[{designators:['A','B'],dxMil:25,dyMil:50}]}];
  let c=reviewFineLayout(s,r).candidates[0];assert.equal(c.changes.length,2);assert.equal(c.metrics.padPairs[0].deltaMil,0);
  r.planInput.scenarios[0].placements=[{designator:'A',x:125,y:150}];assert.throws(()=>reviewFineLayout(s,r),/DUPLICATE_SELECTION/);
});
test('source, ownership, units, incomplete routing and ambiguous pad identities fail closed',()=>{
  const cases=[
    s=>{s.sourceHash=124;},s=>{s.pads[0].parentComponentId='component-B';},s=>{s.units='mm';},
    s=>{delete s.routing.Via;},s=>{s.pads.push({...s.pads[0],id:'ambiguous-pad'});},
  ];
  for(const mutate of cases){const s=fixture();mutate(s);assert.throws(()=>reviewFineLayout(s,request()));}
  const r=request();r.planInput.scenarios[0].placements[0].roation=90;assert.throws(()=>reviewFineLayout(fixture(),r),/UNKNOWN_FIELD/);
});
test('configured assembly margins are evaluated with the shared policy',()=>{
  const rules={schemaVersion:1,profile:{id:'test',label:'test'},source:{title:'test fixture',url:'https://example.invalid'},rules:[{id:'fp',footprintNames:['FP'],marginMm:.25}],independentPads:{marginMm:0,basis:'test'},overrides:[]};
  const s=fixture(),r=request();r.planInput.scenarios[0].placements[0].x=335;
  const out=reviewFineLayout(s,r,rules);assert.equal(out.coverage.assembly,'configured');assert.ok(out.candidates[0].issues.some(i=>i.code.startsWith('ASSEMBLY_')));
});
test('CLI writes immutable review artifacts and host action returns the same candidate metrics',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fine-layout-'));
  try{
    const s=fixture(),r=request(),snapshotFile=join(dir,'snapshot.json'),inputFile=join(dir,'input.json'),report=join(dir,'report');
    await writeFile(snapshotFile,JSON.stringify(s));await writeFile(inputFile,JSON.stringify(r));
    const cli=fileURLToPath(new URL('../scripts/pcb-fine-review.mjs',import.meta.url));
    const args=[cli,'--snapshot',snapshotFile,'--input-file',inputFile,'--report-dir',report];
    const run=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stderr);
    const read=JSON.parse(await readFile(join(report,'review.json'),'utf8'));
    assert.equal(read.candidates[0].metrics.padPairs[0].deltaMil,-50);
    assert.equal(JSON.parse(await readFile(join(report,'placement-plan-shift.json'),'utf8')).mode,'plan');
    assert.match(await readFile(join(report,'comparison.html'),'utf8'),/local-sense/);
    assert.notEqual(spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true}).status,0);
    await writeFile(join(dir,'action-input.json'),JSON.stringify({mode:'review',snapshot:s,request:r}));
    const action=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/action-runner.mjs',import.meta.url)),'run','--action','pcb-fine-review','--input-file',join(dir,'action-input.json'),'--project-root',dir,'--report-file',join(dir,'action-report.json'),'--full'],{encoding:'utf8',windowsHide:true});
    assert.equal(action.status,0,action.stderr+action.stdout);const result=JSON.parse(await readFile(join(dir,'action-report.json'),'utf8'));
    assert.equal(result.response.result.candidates[0].metrics.padPairs[0].deltaMil,-50);
  }finally{await rm(dir,{recursive:true,force:true});}
});
