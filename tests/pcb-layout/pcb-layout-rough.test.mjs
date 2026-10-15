import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFixture,filterRelation,addIntent} from '../helpers/pcb-layout-prepare-fixture.mjs';
import {prepareLayoutInputs} from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import {scopeLayoutModel} from '../../scripts/pcb-layout/pcb-layout-scope.mjs';
import {compileSemanticCpSatProblem,executeCpSat,decodeCpSatCandidate} from '../../scripts/pcb-layout/pcb-layout-cpsat.mjs';
import {compileRoughLayoutPolicy,roughLayoutMetrics} from '../../scripts/pcb-layout/pcb-layout-rough.mjs';
const runtime={pythonPath:process.env.FLITREALIZE_CPSAT_PYTHON};
const skip=!runtime.pythonPath&&'Numeric CP-SAT runtime required';
function model(locked=true){
 const f=addIntent(prepareFixture(),filterRelation());f.config.hard.boardBounds={minX:-50,minY:-50,maxX:250,maxY:150};f.snapshot.components[0].locked=locked;
 const prepared=prepareLayoutInputs(f);assert.equal(prepared.state.ready,true,JSON.stringify(prepared.diagnostics));
 return scopeLayoutModel(prepared.model,{includeLabels:false});
}
const policy={schemaVersion:1,groupCompactnessWeight:.2,density:{weight:.25,cellMil:100,targetCount:1,offsetFractions:[0,.5]}};
test('rough preferences are opt-in and retain native locks, board and source',()=>{
 const m=model(),before=structuredClone(m.snapshot),legacy=compileSemanticCpSatProblem(m,{}, {includeLabels:false}).problem;
 assert.equal(legacy.roughLayout,undefined);
 const p=compileSemanticCpSatProblem(m,{}, {includeLabels:false,roughLayoutPolicy:policy}).problem;
 assert.equal(p.roughLayout.groupCompactnessWeight,.2);assert.deepEqual(p.board,legacy.board);assert.deepEqual(p.pairs,legacy.pairs);
 assert.equal(p.entities.find(e=>e.ref==='U1').fixed,true);assert.equal(p.noInitialHints,true);assert.deepEqual(m.snapshot,before);
});
test('invalid density inputs and open-board scope fail explicitly',()=>{
 const m=model();assert.throws(()=>compileSemanticCpSatProblem(m,{}, {includeLabels:false,roughLayoutPolicy:{...policy,density:{...policy.density,cellMil:0}}}),/INVALID_ROUGH_DENSITY/);
 const p=compileSemanticCpSatProblem(m,{}, {includeLabels:false}).problem;p.openPlacement=true;
 assert.throws(()=>compileRoughLayoutPolicy(m,p,policy),/REQUIRES_BOARD/);
});
test('connection-side reservations rotate with observed pins and exempt declared local parts',()=>{
 const m=model(false),p=compileSemanticCpSatProblem(m,{}, {includeLabels:false}).problem;
 const owner=p.entities.find(e=>e.ref==='U1');
 for(const v of owner.variants){v.padCenters={p1:{x:v.physical.maxX,y:0},p2:{x:v.physical.maxX,y:1}};}
 const synthetic={...m,pads:[{id:'p1',owner:'U1',net:'SIGNAL'},{id:'p2',owner:'U1',net:'GND'},{id:'peer',owner:'C1',net:'SIGNAL'}]};
 const rough=compileRoughLayoutPolicy(synthetic,p,{schemaVersion:1,groupCompactnessWeight:1,connectionSide:{weight:1,minimumConnectedPads:1,excludeNets:['GND'],depthLevels:[{minimumSidePads:1,depthMil:20}],exemptRefsByOwner:{U1:['C1']}}});
 assert.equal(rough.bands.length,1);assert.equal(rough.bands[0].connectedPads,1);assert.deepEqual(rough.bands[0].peerRefs,[]);
 assert.equal(owner.variants.length,4);assert.ok(owner.variants.every(v=>v.roughBands.length===1));
 const rotated=owner.variants.find(v=>v.rotation===90);assert.equal(rotated.roughBands[0].minY,rotated.physical.maxY);assert.equal(rotated.roughBands[0].maxY,rotated.physical.maxY+20);
});
test('actual CP-SAT reserves a connected side and matches the independent intrusion count',{skip},async()=>{
 const m=model();m.config.hard.boardBounds={minX:-200,minY:-50,maxX:250,maxY:150};
 const p=compileSemanticCpSatProblem(m,{timeLimitSeconds:3,workers:1,resolutionMil:.5},{includeLabels:false,roughLayoutPolicy:{schemaVersion:1,groupCompactnessWeight:1,connectionSide:{weight:10,minimumConnectedPads:1,excludeNets:['GND'],depthLevels:[{minimumSidePads:1,depthMil:80}],exemptRelationKinds:[]}}}).problem;
 assert.equal(p.roughLayout.bands[0].owner,'U1');
 p.bodyCoordinateBounds=[{ref:'C1',key:'maxX',minimumMil:-190,maximumMil:-18}];
 const control=structuredClone(p);control.roughLayout.connectionSideWeight=0;
 const a=await executeCpSat(control,runtime),b=await executeCpSat(p,runtime);
 const ac=decodeCpSatCandidate(m,control,a),bc=decodeCpSatCandidate(m,p,b);
 assert.equal(bc.validation.valid,true);
 const am=roughLayoutMetrics(p,ac.plan),bm=roughLayoutMetrics(p,bc.plan);
 assert.ok(bm.connectionSidePenalty<am.connectionSidePenalty,JSON.stringify({am,bm}));
 assert.ok(Math.abs(bm.connectionSidePenalty-b.solver.roughLayout.connectionSidePenalty)<1e-8);
});
test('actual CP-SAT moves a linked part out of a crowded window and matches independent score',{skip},async()=>{
 const m=model(),settings={timeLimitSeconds:3,workers:1,seed:31,resolutionMil:.5};
 const control=compileSemanticCpSatProblem(m,settings,{includeLabels:false,roughLayoutPolicy:{schemaVersion:1,groupCompactnessWeight:0}}).problem;
 const p=compileSemanticCpSatProblem(m,settings,{includeLabels:false,roughLayoutPolicy:{...policy,groupCompactnessWeight:0,density:{...policy.density,weight:20,offsetFractions:[0]}}}).problem;
 const old=await executeCpSat(control,runtime),next=await executeCpSat(p,runtime);
 assert.ok(['FEASIBLE','OPTIMAL'].includes(old.status));assert.ok(['FEASIBLE','OPTIMAL'].includes(next.status));
 const a=decodeCpSatCandidate(m,control,old),b=decodeCpSatCandidate(m,p,next);
 assert.equal(a.validation.valid,true);assert.equal(b.validation.valid,true);
 const am=roughLayoutMetrics(p,a.plan),bm=roughLayoutMetrics(p,b.plan);
 assert.ok(bm.densityPenalty<am.densityPenalty,JSON.stringify({am,bm}));
 assert.ok(Math.abs(bm.densityPenalty-next.solver.roughLayout.densityPenalty)<1e-8);
 const locked=b.plan.components.find(c=>c.ref==='U1');assert.equal(locked.x,0);assert.equal(locked.y,0);assert.equal(next.solver.externalInitialHintCount,0);
});
