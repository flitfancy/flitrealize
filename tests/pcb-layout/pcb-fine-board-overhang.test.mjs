import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFixture} from '../helpers/pcb-layout-prepare-fixture.mjs';
import {prepareLayoutInputs} from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import {normalizeFineRequest} from '../../scripts/pcb-layout/fine/request.mjs';
import {compileFineProblem} from '../../scripts/pcb-layout/fine/compile.mjs';
import {normalizeExternalFinePlan,auditFineCandidate} from '../../scripts/pcb-layout/fine/audit.mjs';

function fixture({bodyOutside=true,padOutside=false,window=false,keepout=false}={}){
  const f=prepareFixture();f.config.hard.boardBounds={minX:0,minY:0,maxX:400,maxY:240};
  for(const c of f.snapshot.components){const x=c.ref==='C1'?(bodyOutside?395:380):40,dx=x-c.x,dy=80;c.x=x;c.y=80;
    for(const b of [c.bbox,...f.snapshot.pads.filter(p=>p.owner===c.ref).map(p=>p.bbox),...f.snapshot.items.filter(l=>l.owner===c.ref).map(l=>l.original.bbox)])for(const k of Object.keys(b))b[k]+=k.endsWith('X')?dx:dy;
    for(const p of f.snapshot.pads.filter(p=>p.owner===c.ref)){p.x+=dx;p.y+=dy;}
    for(const l of f.snapshot.items.filter(l=>l.owner===c.ref)){l.original.x+=dx;l.original.y+=dy;if(c.ref==='C1'){l.original.x-=25;l.original.bbox.minX-=25;l.original.bbox.maxX-=25;}}
  }
  if(padOutside){const p=f.snapshot.pads.find(p=>p.owner==='C1');p.x+=10;p.bbox.minX+=10;p.bbox.maxX+=10;}
  if(keepout)f.config.spatial={zones:[{id:'new-target-zone',mode:'keepout',geometry:'body',box:{minX:388,maxX:399,minY:95,maxY:105},targetRefs:['C1']}]};
  const r={schemaVersion:1,movableRefs:['C1'],fixedRefs:['U1'],region:{mode:window?'window':'available-space',basis:'Preserve a known body-only board overhang while moving parallel to that edge',...(window?{boundsMil:{minX:300,maxX:400,minY:40,maxY:95}}:{})},labels:{mode:'separate',clearanceMil:0},baselinePolicy:'retain-outside-issues',relations:[],routing:{required:false},objective:{retainSource:true}};
  const prepared=prepareLayoutInputs(f);assert.ok(prepared.state.ready,JSON.stringify(prepared.diagnostics));const scope=normalizeFineRequest(prepared.model,r),compilation=compileFineProblem(scope);
  return{f,r,scope,compilation};
}
function audit(c,{dx=0,dy=20}={}){
  const proposal=structuredClone(c.compilation.baseline.plan);proposal.components=proposal.components.map(p=>({id:p.id,ref:p.ref,x:p.x+(p.ref==='C1'?dx:0),y:p.y+(p.ref==='C1'?dy:0),rotation:p.rotation}));proposal.issues=[];
  const plan=normalizeExternalFinePlan(c.scope,c.compilation,proposal);return auditFineCandidate(c.scope,c.compilation,plan);
}
test('board-wide candidate reuses the proven unchanged body overhang with all pads in board',()=>{
  const a=audit(fixture());assert.equal(a.blockingIssues.length,0);assert.ok(a.retainedOutsideIssues.some(i=>i.code==='BOARD_BOUNDARY_VIOLATION'&&i.ref==='C1'));
  assert.deepEqual(a.areaViolations,[]);assert.equal(a.localAccepted,true);assert.equal(a.nativeEligible,true);assert.equal(a.wholeBoardAccepted,false);
  assert.equal(a.retainedAreaProofs.length,1);assert.equal(a.retainedAreaProofs[0].ref,'C1');
});
test('body overhang increasing past its prior depth still blocks',()=>{const a=audit(fixture(),{dx:1});assert.equal(a.localAccepted,false);assert.ok(a.blockingIssues.some(i=>i.code==='BOARD_BOUNDARY_VIOLATION'));assert.deepEqual(a.areaViolations,['C1']);});
test('a new body overhang cannot use the existing-issue allowance',()=>{const a=audit(fixture({bodyOutside:false}),{dx:16});assert.equal(a.localAccepted,false);assert.deepEqual(a.areaViolations,['C1']);});
test('an already-outside solder pad is not permitted by body overhang retention',()=>{const a=audit(fixture({padOutside:true}));assert.equal(a.localAccepted,false);assert.deepEqual(a.areaViolations,['C1']);});
test('smaller declared work window stays strict even beside the same board edge',()=>{const a=audit(fixture({window:true}));assert.equal(a.localAccepted,false);assert.deepEqual(a.areaViolations,['C1']);});
test('body overhang does not suppress a new keepout conflict',()=>{const a=audit(fixture({keepout:true}));assert.equal(a.localAccepted,false);assert.ok(a.blockingIssues.some(i=>i.code==='SPATIAL_KEEPOUT'));});
test('body overhang does not suppress a collision with another component',()=>{const a=audit(fixture(),{dx:-355,dy:0});assert.equal(a.localAccepted,false);assert.ok(a.blockingIssues.some(i=>i.code==='FINE_PHYSICAL_GAP'));});
test('require-clean retains its original rejection of a dirty baseline',()=>{const c=fixture();c.r.baselinePolicy='require-clean';const scope=normalizeFineRequest(prepareLayoutInputs(c.f).model,c.r);assert.throws(()=>compileFineProblem(scope),/FINE_BASELINE_NOT_CLEAN/);});
