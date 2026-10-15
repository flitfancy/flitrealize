import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFixture } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { normalizeFineRequest } from '../../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem } from '../../scripts/pcb-layout/fine/compile.mjs';
import { materializeFineCandidate, auditFineCandidate, verifyFineReadback } from '../../scripts/pcb-layout/fine/audit.mjs';
import { solveFineLayout, applyFineLayout } from '../../scripts/pcb-layout/fine/workflow.mjs';
import { digest } from '../../scripts/pcb-layout/fine/common.mjs';
import { buildGeometryViews } from '../../scripts/pcb-layout/pcb-layout-geometry-views.mjs';
import { fineRoutingRequest, routeFineCandidate, verifyFineRoutingReceipt } from '../../scripts/pcb-layout/fine/routing.mjs';
import { preparePrerouteInput } from '../../scripts/pcb-routing/preroute/prepare.mjs';
import { classifyFineIssues } from '../../scripts/pcb-layout/fine/issue-policy.mjs';

async function temporaryDirectory(t,prefix){const directory=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}

function inputs() {
  const f=prepareFixture();f.config.hard.boardBounds={minX:0,minY:0,maxX:400,maxY:240};
  for(const [index,c] of f.snapshot.components.entries()){
    const dx=(index?220:40)-c.x,dy=80;c.x+=dx;c.y+=dy;
    for(const b of [c.bbox,...f.snapshot.pads.filter(p=>p.owner===c.ref).map(p=>p.bbox),...f.snapshot.items.filter(p=>p.owner===c.ref).map(p=>p.original.bbox)])for(const k of ['minX','maxX','minY','maxY'])b[k]+=k.endsWith('X')?dx:dy;
    for(const p of f.snapshot.pads.filter(p=>p.owner===c.ref)){p.x+=dx;p.y+=dy;}
    for(const l of f.snapshot.items.filter(l=>l.owner===c.ref)){l.original.x+=dx;l.original.y+=dy;}
  }
  return f;
}
const window={minX:180,maxX:300,minY:40,maxY:180};
function request(mode='available-space') {return {schemaVersion:1,blockId:'supply',movableRefs:['C1'],fixedRefs:['U1'],labels:{mode:'joint'},region:{mode,basis:'Explicit test borrowing permission',...(mode==='window'?{boundsMil:window}:{referenceBoundsMil:window})},relations:[{id:'filter',from:{ref:'U1',pin:'1'},to:{ref:'C1',pin:'1'},basis:'Test electrical branch',weight:1,maxDistanceMil:200,nonRegression:{toleranceMil:0},critical:true}],objective:{retainSource:false}};}
function compiled(f=inputs(),r=request()) {const p=prepareLayoutInputs(f);assert.equal(p.state.ready,true,JSON.stringify(p.diagnostics));const scope=normalizeFineRequest(p.model,r);return {f,r,scope,...compileFineProblem(scope,{resolutionMil:.5,timeLimitSeconds:2,workers:1})};}
function baselineResult(c) {return {status:'FEASIBLE',sourceHash:c.scope.model.snapshot.sourceHash,placements:c.problem.entities.map(e=>({ref:e.ref,dx:0,dy:0,variant:e.preferredVariant??0})),solver:{wallSeconds:0}};}

test('full model keeps fixed external real pad endpoints and lock provenance',()=>{const c=compiled();assert.equal(c.problem.entities.length,2);assert.equal(c.problem.entities.find(e=>e.ref==='U1').fixed,true);assert.equal(c.problem.entities.find(e=>e.ref==='C1').fixed,false);assert.equal(c.scope.crossingNets[0].endpoints.length,2);assert.ok(c.problem.links.some(l=>l.left[0].ref==='U1'));assert.ok(c.problem.zones.some(z=>z.id==='fine-context-placement:U1'));assert.ok(c.scope.lockSources.U1.includes('fine.request.fixed'));});
test('frozen source limits evaluate every alternative pin without replacing endpoint identities',()=>{
 const f=inputs(),old=f.snapshot.components[0],c=structuredClone(old);c.id='U2:';c.ref='U2';c.x=350;c.bbox={minX:340,maxX:360,minY:70,maxY:90};f.snapshot.components.push(c);
 for(const[number,x]of [['1',350],['2',345]]){const p=structuredClone(f.snapshot.pads[0]);p.id='U2:'+number;p.owner='U2';p.number=number;p.x=x;p.bbox={minX:x-2,maxX:x+2,minY:78,maxY:82};f.snapshot.pads.push(p);f.contract.nets[0].endpoints.push({component:'U2',pin:number});}
 const l=structuredClone(f.snapshot.items[0]);l.id='U2:label';l.owner='U2';l.parentId=c.id;l.text='U2';l.original.x=340;l.original.bbox={minX:340,maxX:360,minY:105,maxY:115};f.snapshot.items.push(l);
 f.contract.components.push({designator:'U2',role:'fixed multiple-pad endpoint',includeInPcb:true,pins:[{number:'1'},{number:'2'}]});f.contract.blocks[0].components.push('U2');
 f.config.hard.pinDistanceLimits=[{id:'frozen-alternative-pins',a:'U1',aPin:'1',b:'U2',net:'SUPPLY',maxMil:310}];
 const checked=compiled(f),limit=checked.constantLimits.find(l=>l.id==='frozen-alternative-pins');assert.equal(limit.distanceMil,305);assert.equal(limit.passed,true);assert.ok(!checked.problem.limits.some(l=>l.id===limit.id));
});
test('available-space searches the real board while window keeps its declared domain',()=>{const a=compiled(),b=compiled(inputs(),request('window'));assert.deepEqual(a.scope.request.region.boundsMil,a.scope.model.config.hard.boardBounds);assert.equal(b.problem.bodyCoordinateBounds.find(b=>b.key==='minX').minimumMil,180);assert.ok(b.problem.zones.some(z=>z.id.startsWith('fine-region-physical:')));});
test('native and mechanical locks cannot be released by requesting a movable ref',()=>{for(const lock of ['native','mechanical']){const f=inputs();if(lock==='native')f.snapshot.components[1].locked=true;else f.mechanical.lockedDesignators=['C1'];assert.throws(()=>compiled(f),/FINE_LOCKED_MOVABLE/);}});
test('only explicit hard.fixed locks with known provenance may be released',()=>{const f=inputs();f.config.hard.fixed=[{ref:'C1',x:220,y:80,rotation:0}];assert.throws(()=>compiled(f),/FINE_LOCKED_MOVABLE/);const r=request();r.releaseFixedRefs=['C1'];assert.equal(compiled(f,r).problem.entities.find(e=>e.ref==='C1').fixed,false);f.snapshot.components[1].locked=true;assert.throws(()=>compiled(f,r),/OPEN_NATIVE_LOCK_RELEASE_FORBIDDEN/);});
test('individual locked labels do not become movable implicitly',()=>{const f=inputs();f.snapshot.items[1].locked=true;assert.throws(()=>compiled(f),/FINE_LOCKED_LABEL_OWNER/);});
test('neighbors are explicit and all other components remain context',()=>{const r=request();r.fixedRefs=[];r.allowedNeighborRefs=['U1'];const c=compiled(inputs(),r);assert.equal(c.problem.entities.filter(e=>!e.fixed).length,2);r.allowedNeighborRefs=['C1'];assert.throws(()=>compiled(inputs(),r),/FINE_SCOPE_CONFLICT/);});
test('region overflow, undeclared policies and unsupported label stages fail early',()=>{for(const mutate of [r=>r.region.boundsMil={minX:-1,maxX:200,minY:0,maxY:200},r=>r.labels={mode:'shrink-to-fit'},r=>r.region.mode='grow-until-success',r=>r.infiniteLoop=true]){const r=request();mutate(r);assert.throws(()=>compiled(inputs(),r),/FINE_/);}});
test('relations resolve actual pins and reject mismatched nets or missing basis',()=>{for(const mutate of [r=>r.relations[0].net='wrong',r=>r.relations[0].to.pin='99',r=>delete r.relations[0].basis]){const r=request();mutate(r);assert.throws(()=>compiled(inputs(),r),/FINE_/);}});
test('hard caps and non-regression remain separate from weighted objectives',()=>{const c=compiled();assert.ok(c.problem.limits.some(l=>l.id==='fine-hard:filter'&&l.maxMil===200));assert.ok(c.problem.limits.some(l=>l.id==='fine-comparison:filter'&&l.maxMil===180));assert.equal(c.problem.links.find(l=>l.id==='fine-soft:filter').weight,1);});
test('compile and materialization do not mutate original inputs or context labels',()=>{const f=inputs(),before=digest(f),c=compiled(f),candidate=materializeFineCandidate(c.scope,c,baselineResult(c));assert.equal(digest(f),before);assert.equal(candidate.plan.components.length,2);assert.equal(candidate.plan.labels.length,2);assert.equal(candidate.audit.outsidePreserved,true);assert.equal(candidate.plan.sourceHash,7);});
test('an uncovered critical relationship cannot pass because the total score improved',()=>{const r=request();delete r.relations[0].maxDistanceMil;delete r.relations[0].nonRegression;const c=compiled(inputs(),r),candidate=materializeFineCandidate(c.scope,c,baselineResult(c));assert.deepEqual(candidate.audit.unboundCritical,['filter']);assert.equal(candidate.audit.localAccepted,false);});
test('outside pose and labels are checked again after full candidate reconstruction',()=>{const c=compiled(),candidate=materializeFineCandidate(c.scope,c,baselineResult(c));candidate.plan.components[0].x+=1;assert.equal(auditFineCandidate(c.scope,c,candidate.plan).outsidePreserved,false);});
test('required routing is blocked before native execution',async()=>{const f=inputs(),r=request();r.routing={required:true,nets:['SUPPLY']};const c=compiled(f,r),candidate=materializeFineCandidate(c.scope,c,baselineResult(c));const solved=await solveFineLayout({inputs:f,request:r,executor:async()=>baselineResult(c)});if(!solved.candidate.audit.localAccepted)assert.fail(JSON.stringify(solved.candidate.audit));let calls=0;await assert.rejects(applyFineLayout({inputs:f,request:r,candidate:solved.candidate,result:solved.result,options:{},execution:async()=>{calls++;}}),/FINE_REQUIRED_ROUTING_NOT_VERIFIED/);assert.equal(calls,0);});
test('candidate and input fingerprints stop stale writes',async()=>{const f=inputs(),r=request(),c=compiled(f,r),s=await solveFineLayout({inputs:f,request:r,executor:async()=>baselineResult(c)});s.candidate.plan.components[1].x++;await assert.rejects(applyFineLayout({inputs:f,request:r,candidate:s.candidate,result:s.result,options:{}}),/FINE_CANDIDATE_CHANGED/);});
test('failure status distinguishes invalid model and bounded search exhaustion',async()=>{for(const [solverStatus,status] of [['MODEL_INVALID','model-invalid'],['UNKNOWN','budget-exhausted'],['INFEASIBLE','infeasible-for-compiled-model']]){const s=await solveFineLayout({inputs:inputs(),request:request(),executor:async()=>({status:solverStatus,solver:{branches:0}})});assert.equal(s.result.status,status);assert.equal(s.result.state.nativeWrites,0);}});
test('readback checks real pad identities and prevents saved-but-mismatched success',()=>{const c=compiled(),candidate=materializeFineCandidate(c.scope,c,baselineResult(c)),g=buildGeometryViews(c.scope.model.geometryModel,candidate.plan.components,candidate.plan.labels,candidate.plan.testPads);const actual={placements:candidate.plan.components,labels:candidate.plan.labels,pads:g.pads,outlines:c.f.snapshot.outlines,routing:c.f.snapshot.routing};assert.equal(verifyFineReadback(c.scope.model,candidate.plan,actual).verified,true);actual.pads=structuredClone(actual.pads);actual.pads[0].net='changed';assert.throws(()=>verifyFineReadback(c.scope.model,candidate.plan,actual),/FINE_READBACK_PAD/);});
test('saved evidence includes source, scope, candidate hash and explicit offline state',async t=>{const dir=await temporaryDirectory(t,'fine-layout-test-'),f=inputs(),r=request(),c=compiled(f,r);const s=await solveFineLayout({inputs:f,request:r,directory:dir,executor:async()=>baselineResult(c)});const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));assert.equal(manifest.candidateHash,s.candidate.candidateHash);assert.equal(manifest.candidateFileHash,digest(s.candidate));assert.equal(s.result.routing.status,'not-run');assert.equal(s.result.state.saved,false);});
test('real public backend uses surrounding free space under the SAME budget', {skip:!process.env.FLITREALIZE_CPSAT_PYTHON&&'Existing OR-Tools runtime required'},async()=>{const f=inputs(),settings={resolutionMil:.5,timeLimitSeconds:2,workers:1,seed:9},runtime={pythonPath:process.env.FLITREALIZE_CPSAT_PYTHON};const a=await solveFineLayout({inputs:f,request:request('window'),settings,runtime}),b=await solveFineLayout({inputs:f,request:request(),settings,runtime});assert.equal(a.result.status,'candidate-passed',JSON.stringify(a.result.audit));assert.equal(b.result.status,'candidate-passed',JSON.stringify(b.result.audit));assert.ok(b.result.audit.relations[0].afterMil<a.result.audit.relations[0].afterMil);assert.deepEqual(b.result.audit.borrowedRefs,['C1']);assert.equal(b.result.audit.outsidePreserved,true);});

function routingRequest(){const r=request();r.routing={required:true,nets:['SUPPLY'],policy:{layers:[{id:1,purpose:'top-copper'},{id:2,purpose:'bottom-copper'}],nets:[{net:'SUPPLY',defaultWireWidthMil:2,preroute:{sourceOwners:['U1'],allowedLayers:[1]}}]},options:{clearanceMil:2,copperEdgeMil:0,gridMil:2}};return r;}
const copper=()=>({segments:[{id:'trial-wire',net:'SUPPLY',layer:1,width:2,x1:40,y1:80,x2:220,y2:80}],vias:[]});
test('routing handoff binds the complete actual pad set to the candidate',()=>{const c=compiled(inputs(),routingRequest()),candidate=materializeFineCandidate(c.scope,c,baselineResult(c)),study=fineRoutingRequest(c.scope,candidate.plan),p=preparePrerouteInput(study);assert.equal(p.pads.length,c.f.snapshot.pads.length);assert.deepEqual(p.pads.map(p=>p.net),['SUPPLY','SUPPLY']);assert.deepEqual(p.nets.map(n=>n.net),['SUPPLY']);});
test('required trial routing rechecks actual connectivity rather than an asserted status',async t=>{const c=compiled(inputs(),routingRequest()),candidate=materializeFineCandidate(c.scope,c,baselineResult(c)),dir=await temporaryDirectory(t,'fine-route-');const receipt=await routeFineCandidate({scope:c.scope,candidate,directory:dir,runner:async()=>({candidate:copper()})});assert.equal(receipt.status,'passed');assert.equal(receipt.nativeWrites,0);assert.equal((await verifyFineRoutingReceipt(c.scope,candidate,receipt)).nowConnected,1);receipt.copper.segments=[];await assert.rejects(verifyFineRoutingReceipt(c.scope,candidate,receipt),/FINE_ROUTING_REVERIFICATION_FAILED/);});
test('empty copper cannot pass a required net even when geometric verification has no issues',async t=>{const c=compiled(inputs(),routingRequest()),candidate=materializeFineCandidate(c.scope,c,baselineResult(c)),dir=await temporaryDirectory(t,'fine-route-empty-');const receipt=await routeFineCandidate({scope:c.scope,candidate,directory:dir,runner:async()=>({candidate:{segments:[],vias:[]}})});assert.equal(receipt.status,'failed');assert.deepEqual(receipt.verification.remaining,['SUPPLY']);});
test('unconfigured critical-net widths and delegated ground remain explicit blockers',async t=>{for(const mutate of [r=>delete r.routing.policy.nets[0].defaultWireWidthMil,r=>r.routing.options.verification={enforceDeclaredWidths:false}]){const r=routingRequest();mutate(r);const c=compiled(inputs(),r),candidate=materializeFineCandidate(c.scope,c,baselineResult(c));assert.throws(()=>fineRoutingRequest(c.scope,candidate.plan),/FINE_ROUTING_/);}const r=routingRequest();r.routing.policy.nets[0].roles=[{name:'ground_plane'}];const c=compiled(inputs(),r),candidate=materializeFineCandidate(c.scope,c,baselineResult(c)),dir=await temporaryDirectory(t,'fine-route-ground-');await assert.rejects(routeFineCandidate({scope:c.scope,candidate,directory:dir}),/FINE_ROUTING_DELEGATED_NET/);});
test('proven unchanged outside issues allow local native eligibility without whole-board acceptance',async()=>{const f=inputs(),label=f.snapshot.items[0];label.original.x=-20;label.original.bbox={minX:-20,maxX:0,minY:105,maxY:115};const r=request();r.baselinePolicy='retain-outside-issues';const c=compiled(f,r),s=await solveFineLayout({inputs:f,request:r,executor:async()=>baselineResult(c)});assert.equal(s.candidate.audit.localAccepted,true);assert.equal(s.candidate.audit.nativeEligible,true);assert.equal(s.candidate.audit.wholeBoardAccepted,false);assert.ok(s.candidate.audit.retainedOutsideIssues.length);});
test('per-branch acceptance rejects a regression even when the weighted total improves',()=>{const f=inputs(),c=structuredClone(f.snapshot.components[1]);c.id='U2:';c.ref='U2';c.x=350;c.bbox={minX:340,maxX:360,minY:70,maxY:90};f.snapshot.components.push(c);const p=structuredClone(f.snapshot.pads[1]);p.id='U2:1';p.owner='U2';p.x=350;p.bbox={minX:348,maxX:352,minY:78,maxY:82};f.snapshot.pads.push(p);const l=structuredClone(f.snapshot.items[1]);l.id='U2:label';l.owner='U2';l.parentId='U2:';l.text='U2';l.original.x=340;l.original.bbox={minX:340,maxX:360,minY:105,maxY:115};f.snapshot.items.push(l);f.contract.components.push({designator:'U2',role:'external',includeInPcb:true,pins:[{number:'1'}]});f.contract.nets[0].endpoints.push({component:'U2',pin:'1'});const r=request();r.relations.push({id:'downstream',from:{ref:'C1',pin:'1'},to:{ref:'U2',pin:'1'},basis:'External endpoint preference',weight:10});const cc=compiled(f,r),result=baselineResult(cc);result.placements.find(p=>p.ref==='C1').dx=60;const candidate=materializeFineCandidate(cc.scope,cc,result);assert.ok(candidate.audit.weightedAfterMil<candidate.audit.weightedBeforeMil);assert.equal(candidate.audit.relations[0].passed,false);assert.equal(candidate.audit.localAccepted,false);assert.ok(candidate.audit.regressions.includes('filter'));});

test('permission to move a fixed body label does not make that body an active label object',()=>{
 const f=inputs(),c=structuredClone(f.snapshot.components[0]);c.id='U2:';c.ref='U2';c.x=350;c.bbox={minX:340,maxX:360,minY:70,maxY:90};f.snapshot.components.push(c);
 const pad=structuredClone(f.snapshot.pads[0]);pad.id='U2:1';pad.owner='U2';pad.x=350;pad.bbox={minX:348,maxX:352,minY:78,maxY:82};f.snapshot.pads.push(pad);
 const l=structuredClone(f.snapshot.items[0]);l.id='U2:label';l.owner='U2';l.parentId=c.id;l.text='U2';l.original.x=30;l.original.y=75;l.original.bbox={minX:30,maxX:50,minY:75,maxY:85};f.snapshot.items.push(l);
 f.contract.components.push({designator:'U2',role:'external label fixture',includeInPcb:true,pins:[{number:'1'}]});f.contract.nets[0].endpoints.push({component:'U2',pin:'1'});
 const r=request();r.labels={mode:'separate',additionalOwnerRefs:['U1']};r.baselinePolicy='retain-outside-issues';const cc=compiled(f,r),candidate=materializeFineCandidate(cc.scope,cc,baselineResult(cc));
 const own=candidate.plan.labels.find(l=>l.owner==='U1');own.x+=5;own.bbox.minX+=5;own.bbox.maxX+=5;
 const audit=auditFineCandidate(cc.scope,cc,candidate.plan);assert.equal(audit.localAccepted,true,JSON.stringify(audit.blockingIssues));assert.equal(audit.nativeEligible,true);assert.equal(audit.wholeBoardAccepted,false);
 assert.ok(audit.retainedOutsideIssues.some(i=>i.code==='FINE_LABEL_BODY_GAP'&&i.owner==='U2'&&i.ref==='U1'));
});

test('trial routing rejects a nonzero board origin before invoking the backend',()=>{
 const f=inputs();f.config.hard.boardBounds.minX=-10;
 const c=compiled(f,routingRequest());
 assert.throws(()=>fineRoutingRequest(c.scope,c.baseline.plan),/FINE_ROUTING_BOARD_UNSUPPORTED/);
});

test('fixed unrelated keepout failures remain in the complete baseline report without constant solver failures',()=>{
 const f=inputs();f.config.spatial={zones:[{id:'old-fixed-zone',mode:'keepout',geometry:'body',box:{minX:35,maxX:45,minY:75,maxY:85}}]};
 const r=request();assert.throws(()=>compiled(f,r),/FINE_BASELINE_NOT_CLEAN/);r.baselinePolicy='retain-outside-issues';
 const c=compiled(f,r),old=c.baseline.validation.issues.find(i=>i.code==='SPATIAL_KEEPOUT');assert.equal(old.ref,'U1');assert.ok(old.shapes.every(s=>Number.isFinite(s.penetrationXMil)));
 assert.deepEqual(c.problem.zones.find(z=>z.id==='old-fixed-zone').targetRefs,['C1']);
 assert.ok(c.constantConstraints.some(c=>c.kind==='keepout'&&c.id==='old-fixed-zone:U1'&&c.issues.length));
 const candidate=materializeFineCandidate(c.scope,c,baselineResult(c));assert.equal(candidate.audit.localAccepted,true,JSON.stringify(candidate.audit.blockingIssues));
 assert.ok(candidate.audit.retainedOutsideIssues.some(i=>i.id==='old-fixed-zone'));
});
test('moving keepout owners still constrain fixed external targets and fixed geometry stays real',()=>{
 const f=inputs();f.config.spatial={zones:[{id:'moving-owner',owner:'C1',mode:'keepout',geometry:'body',box:{minX:-185,maxX:-175,minY:-5,maxY:5},targetRefs:['U1']}]};
 const r=request();r.baselinePolicy='retain-outside-issues';const c=compiled(f,r);
 assert.deepEqual(c.problem.zones.find(z=>z.id==='moving-owner').targetRefs,['U1']);
 assert.equal(c.problem.entities.find(e=>e.ref==='U1').variants[0].body.maxX-c.problem.entities.find(e=>e.ref==='U1').variants[0].body.minX,20);
 assert.ok(c.problem.zones.some(z=>z.id==='fine-context-physical:U1:8'&&z.targetRefs.includes('C1')));
});
test('fixed spatial relations and blocks are partitioned by all anchors, while cross-boundary rules remain',()=>{
 const f=inputs(),c=structuredClone(f.snapshot.components[0]);c.id='U2:';c.ref='U2';c.x+=310;c.bbox.minX+=310;c.bbox.maxX+=310;f.snapshot.components.push(c);
 const p=structuredClone(f.snapshot.pads[0]);p.id='U2:1';p.owner='U2';p.x+=310;p.bbox.minX+=310;p.bbox.maxX+=310;f.snapshot.pads.push(p);
 const l=structuredClone(f.snapshot.items[0]);l.id='U2:label';l.owner='U2';l.parentId=c.id;l.text='U2';l.original.x+=310;l.original.bbox.minX+=310;l.original.bbox.maxX+=310;f.snapshot.items.push(l);
 f.contract.components.push({designator:'U2',role:'fixed external anchor',includeInPcb:true,pins:[{number:'1'}]});f.contract.blocks[0].components.push('U2');f.contract.nets[0].endpoints.push({component:'U2',pin:'1'});
 f.config.componentFeatures=[{ref:'U1',block:{anchors:['U2'],maxDistanceMil:10}},{ref:'C1',block:{anchors:['U1'],maxDistanceMil:10}}];
 f.config.spatial={relations:[{id:'fixed-distance',a:'U1',b:'U2',metric:'origin-manhattan',category:'proximity',band:{hardMaxMil:20,scaleMil:1}},{id:'cross-distance',a:'U1',b:'C1',metric:'origin-manhattan',category:'proximity',band:{hardMaxMil:10,scaleMil:1}}]};
 const r=request();r.baselinePolicy='retain-outside-issues';const result=compiled(f,r);
 assert.deepEqual(result.problem.blocks.map(r=>r.ref),['C1']);assert.deepEqual(result.problem.relations.map(r=>r.id),['cross-distance']);
 assert.ok(result.baseline.validation.issues.some(i=>i.code==='SPATIAL_DISTANCE_LIMIT'&&i.id==='fixed-distance'));
 assert.ok(result.baseline.validation.issues.some(i=>i.code==='BLOCK_DISTANCE_EXCEEDED'&&i.ref==='U1'));
 assert.ok(result.baseline.validation.issues.some(i=>i.code==='BLOCK_DISTANCE_EXCEEDED'&&i.ref==='C1'));
});
test('an old geometric failure never suppresses initial spatial or electrical findings',()=>{
 const f=inputs();f.snapshot.items[0].original.bbox.minX=-30;f.config.hard.pinDistanceLimits=[{id:'strict-source',a:'U1',aPin:'1',b:'C1',bPin:'1',net:'SUPPLY',maxMil:10}];
 f.config.spatial={zones:[{id:'fixed-zone',mode:'keepout',geometry:'body',box:{minX:35,maxX:45,minY:75,maxY:85}}]};
 const r=request();r.baselinePolicy='retain-outside-issues';const c=compiled(f,r),codes=c.baseline.validation.issues.map(i=>i.code);
 assert.ok(codes.includes('BOARD_BOUNDARY_VIOLATION'));assert.ok(codes.includes('SPATIAL_KEEPOUT'));assert.ok(codes.includes('PIN_DISTANCE_LIMIT'));
 assert.ok(c.problem.limits.some(l=>l.id==='strict-source'),'real moving/fixed endpoints still enforce source caps');
});
test('explicit active label distance caps cannot be retained as unchanged baseline failures',()=>{
 const r=request();r.labels={mode:'separate',clearanceMil:0,maxOwnerDistanceMil:1};r.baselinePolicy='retain-outside-issues';
 const c=compiled(inputs(),r),audit=auditFineCandidate(c.scope,c,c.baseline.plan);
 assert.ok(audit.blockingIssues.some(i=>i.code==='FINE_LABEL_OWNER_DISTANCE'&&i.owner==='C1'));
 assert.equal(audit.localAccepted,false);
});

test('eight outside issues need independent non-worsening proofs; one regression or substituted issue still blocks',()=>{
 const before={components:[{id:'fixed-body',ref:'A',x:0,y:0,rotation:0,body:{minX:-10,maxX:10,minY:-10,maxY:10}}],
  labels:Array.from({length:8},(_,i)=>({id:'external-label-'+i,owner:'B',x:1,y:0,rotation:0,bbox:{minX:-1,maxX:3,minY:-2,maxY:2}})),pads:[],rules:{clearanceMil:8}};
 const baselineIssues=before.labels.map(l=>({code:'FINE_LABEL_BODY_GAP',id:l.id,owner:l.owner,ref:'A',gapMil:-11,requiredMil:8}));
 const after=structuredClone(before);
 for(const l of after.labels){l.x=2;l.bbox.minX++;l.bbox.maxX++;}
 const issues=baselineIssues.map(i=>({...i,gapMil:-10}));
 const check=(frame,current)=>classifyFineIssues({before,after:frame,issues:current,baselineIssues,labelMode:'separate',baselinePolicy:'retain-outside-issues'});
 const accepted=check(after,issues);
 assert.deepEqual(accepted.blockingIssues,[]);
 assert.equal(accepted.retainedOutsideProofs.length,8);
 assert.ok(accepted.retainedOutsideProofs.every(p=>p.proof==='per-issue-non-worsening'&&p.measurement.after.gapMil>p.measurement.before.gapMil));
 const worsened=structuredClone(after);worsened.labels[0].x=0;worsened.labels[0].bbox={minX:-2,maxX:2,minY:-2,maxY:2};
 const rejected=check(worsened,issues.map((i,n)=>n?i:{...i,gapMil:-12}));
 assert.deepEqual(rejected.blockingIssues.map(i=>i.id),['external-label-0'],'Seven improvements cannot compensate one deeper intrusion');
 assert.equal(rejected.retainedOutsideProofs.length,7);
 const substituted=check(after,issues.map((i,n)=>n?i:{...i,requiredMil:9}));
 assert.deepEqual(substituted.blockingIssues.map(i=>i.id),['external-label-0'],'Equal issue counts cannot replace the original rule');
});

test('bounded numeric backend drops only the proven fixed zone failure and retains an active-owner conflict',{
 skip:!process.env.FLITREALIZE_CPSAT_PYTHON&&'Existing OR-Tools runtime required'
},async()=>{
 const {executeCpSat}=await import('../../scripts/pcb-layout/pcb-layout-cpsat.mjs');
 const runtime={pythonPath:process.env.FLITREALIZE_CPSAT_PYTHON};
 const f=inputs();f.config.spatial={zones:[{id:'old-fixed-zone',mode:'keepout',geometry:'body',box:{minX:35,maxX:45,minY:75,maxY:85}}]};
 const r=request();r.baselinePolicy='retain-outside-issues';const c=compiled(f,r),result=await executeCpSat(c.problem,runtime);
 assert.ok(['FEASIBLE','OPTIMAL'].includes(result.status),JSON.stringify(result));
 const candidate=materializeFineCandidate(c.scope,c,result);assert.equal(candidate.audit.localAccepted,true,JSON.stringify(candidate.audit));
 const g=inputs();g.config.spatial={zones:[{id:'moving-owner',owner:'C1',mode:'keepout',geometry:'body',box:{minX:-185,maxX:-175,minY:-5,maxY:5},targetRefs:['U1']}]};
 const active=compiled(g,r);active.problem.entities.find(e=>e.ref==='C1').radiusMil=0;
 const rotated=await executeCpSat(active.problem,runtime);assert.ok(['FEASIBLE','OPTIMAL'].includes(rotated.status),JSON.stringify(rotated));
 const repaired=materializeFineCandidate(active.scope,active,rotated);assert.equal(repaired.audit.localAccepted,true,JSON.stringify(repaired.audit));
 assert.notEqual(repaired.plan.components.find(c=>c.ref==='C1').rotation,0,'rotation can legitimately move the owner-local zone away');
 g.config.hard.preserveRotations=true;const lockedRotation=compiled(g,r);lockedRotation.problem.entities.find(e=>e.ref==='C1').radiusMil=0;
 const blocked=await executeCpSat(lockedRotation.problem,runtime);assert.equal(blocked.status,'INFEASIBLE',JSON.stringify(blocked));
});
