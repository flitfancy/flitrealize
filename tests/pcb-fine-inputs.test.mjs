import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFixture, addIntent, filterRelation } from './helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { normalizeFineRequest } from '../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem, relationDistance } from '../scripts/pcb-layout/fine/compile.mjs';
import { auditFineCandidate } from '../scripts/pcb-layout/fine/audit.mjs';

function inputs() {
  const f=addIntent(prepareFixture(),filterRelation());
  f.config.hard.boardBounds={minX:-50,minY:-50,maxX:500,maxY:240};
  return f;
}
function request(extra={}) {
  return {schemaVersion:1,blockId:'supply',fixedRefs:['U1'],region:{mode:'available-space',basis:'Test declared board space'},labels:{mode:'separate'},...extra};
}
function compile(f=inputs(),r=request()) {
  const prepared=prepareLayoutInputs(f);
  assert.equal(prepared.state.ready,true,JSON.stringify(prepared.diagnostics));
  const scope=normalizeFineRequest(prepared.model,r);
  return {scope,...compileFineProblem(scope)};
}
function reference(extra={}) { return {relationId:'supply-filter',...extra}; }
function withNeighbor(f=inputs()) {
  const c=structuredClone(f.snapshot.components[1]);c.id='R1:';c.ref='R1';c.x=350;c.bbox={minX:340,maxX:360,minY:-10,maxY:10};f.snapshot.components.push(c);
  const p=structuredClone(f.snapshot.pads[1]);p.id='R1:1';p.owner='R1';p.x=350;p.bbox={minX:348,maxX:352,minY:-2,maxY:2};f.snapshot.pads.push(p);
  const l=structuredClone(f.snapshot.items[1]);l.id='R1:label';l.owner='R1';l.parentId='R1:';l.text='R1';l.original.x=340;l.original.bbox={minX:340,maxX:360,minY:25,maxY:35};f.snapshot.items.push(l);
  f.contract.components.push({designator:'R1',includeInPcb:true,pins:[{number:'1'}]});
  f.contract.blocks.push({id:'neighbor',purpose:'Test separate block',components:['R1']});
  f.contract.nets[0].endpoints.push({component:'R1',pin:'1'});return f;
}

test('block default excludes explicit fixed parts, keeps independent label permission and full context',()=>{
  const c=compile(inputs(),request({labels:{mode:'separate',additionalOwnerRefs:['U1']}}));
  assert.deepEqual(c.scope.request.movableRefs,['C1']);assert.deepEqual([...c.scope.labelMoving],['C1','U1']);
  assert.equal(c.scope.selection.primarySource,'contract.blocks/supply');assert.deepEqual(c.scope.selection.excluded[0].sources,['fine.request.fixed']);
  assert.equal(c.problem.entities.length,2);assert.equal(c.scope.crossingNets[0].endpoints.length,2);
});
test('rotation-only intent does not fix a main component position',()=>{
  const f=inputs();f.config.componentFeatures=[{ref:'U1',allowedRotationDeltas:[0]}];
  const c=compile(f,request({fixedRefs:[]}));assert.deepEqual(c.scope.request.movableRefs,['U1','C1']);
  assert.equal(c.problem.entities.find(e=>e.ref==='U1').fixed,false);assert.deepEqual(c.scope.model.allowedRotations.get('U1'),[0]);
});
test('derived membership excludes native, mechanical, ordinary fixed and pad locks with provenance',()=>{
  for(const kind of ['native','mechanical','fixed','pad']){
    const f=inputs();if(kind==='native')f.snapshot.components[1].locked=true;
    if(kind==='mechanical')f.mechanical.lockedDesignators=['C1'];
    if(kind==='fixed')f.config.hard.fixed=[{ref:'C1',x:150,y:0,rotation:0}];
    if(kind==='pad')f.snapshot.pads[1].locked=true;
    const c=compile(f,request({fixedRefs:[]}));assert.deepEqual(c.scope.request.movableRefs,['U1']);
    assert.ok(c.scope.selection.excluded.find(e=>e.ref==='C1').sources.length);
  }
});
test('explicit movable list overrides block default and rejects locks or outside members',()=>{
  assert.deepEqual(compile(inputs(),request({movableRefs:['U1'],fixedRefs:[]})).scope.request.movableRefs,['U1']);
  const f=inputs();f.snapshot.components[1].locked=true;assert.throws(()=>compile(f,request({movableRefs:['C1']})),/FINE_LOCKED_MOVABLE/);
  assert.throws(()=>compile(withNeighbor(),request({movableRefs:['R1']})),/FINE_PRIMARY_OUTSIDE_BLOCK/);
});
test('missing scope, empty scope and unknown block fail without widening permissions',()=>{
  assert.throws(()=>compile(inputs(),request({blockId:undefined})),/FINE_BLOCK_OR_MOVABLE_REQUIRED/);
  assert.throws(()=>compile(inputs(),request({movableRefs:[]})),/FINE_SCOPE_CONFLICT/);
  assert.throws(()=>compile(inputs(),request({blockId:'unknown'})),/FINE_UNKNOWN_BLOCK/);
  assert.throws(()=>compile(inputs(),request({fixedRefs:['U1','C1']})),/FINE_SCOPE_CONFLICT/);
});
test('derived scope releases only explicitly named ordinary fixed locks',()=>{
  const f=inputs();f.config.hard.fixed=[{ref:'C1',x:150,y:0,rotation:0}];
  assert.deepEqual(compile(f,request({releaseFixedRefs:['C1']})).scope.request.movableRefs,['C1']);
  f.snapshot.components[1].locked=true;assert.throws(()=>compile(f,request({releaseFixedRefs:['C1']})),/OPEN_NATIVE_LOCK_RELEASE_FORBIDDEN/);
});
test('neighbor block membership is an explicit flexible expansion and respects fixed parts',()=>{
  const f=withNeighbor();const c=compile(f,request({allowedNeighborBlockIds:['neighbor']}));
  assert.deepEqual(c.scope.request.allowedNeighborRefs,['R1']);assert.equal(c.problem.entities.find(e=>e.ref==='R1').fixed,false);
  assert.deepEqual(compile(f,request()).scope.request.allowedNeighborRefs,[]);
  const fixed=compile(f,request({allowedNeighborBlockIds:['neighbor'],fixedRefs:['U1','R1']}));
  assert.deepEqual(fixed.scope.request.allowedNeighborRefs,[]);assert.ok(fixed.scope.selection.excluded.some(e=>e.role==='neighbor'&&e.ref==='R1'));
});
test('neighbor block selectors reject unknown, duplicate and primary block identities',()=>{
  for(const [ids,error]of [[['unknown'],/FINE_UNKNOWN_NEIGHBOR_BLOCK/],[['neighbor','neighbor'],/FINE_INVALID_NEIGHBOR_BLOCKS/],[['supply'],/FINE_NEIGHBOR_BLOCK_SCOPE_CONFLICT/]])assert.throws(()=>compile(withNeighbor(),request({allowedNeighborBlockIds:ids})),error);
});
test('explicit neighbor permissions still reject locked objects rather than dropping them',()=>{
  const f=withNeighbor();f.snapshot.components[2].locked=true;
  assert.deepEqual(compile(f,request({allowedNeighborBlockIds:['neighbor']})).scope.request.allowedNeighborRefs,[]);
  assert.throws(()=>compile(f,request({allowedNeighborRefs:['R1']})),/FINE_LOCKED_MOVABLE/);
});
test('independent extra label scope preserves native label locks',()=>{
  const f=inputs();f.snapshot.items[0].locked=true;
  assert.throws(()=>compile(f,request({labels:{mode:'separate',additionalOwnerRefs:['U1']}})),/FINE_LOCKED_LABEL_OWNER/);
  assert.deepEqual([...compile(f).scope.labelMoving],['C1']);
});
test('inherit, replace and append compose exactly the declared objective weights without duplicate scoring',()=>{
  const f=inputs(), original=structuredClone(f);
  f.config.comparisonWeights.bypass=8;
  const base=compile(f,request({relations:[reference()]})),sourceWeight=base.effectiveRelations[0].weight;
  assert.ok(sourceWeight>0);
  for(const [change,expectedWeights,sourceRetained] of [
    [{},[sourceWeight],true],
    [{merge:'replace-objective',weight:4,geometry:'bbox-center'},[4],false],
    [{merge:'append-objective',weight:2,geometry:'bbox-center'},[sourceWeight,2],true],
    [{merge:'replace-objective',weight:0},[],false]
  ]){
    const c=compile(f,request({relations:[reference(change)]})),r=c.effectiveRelations[0];
    assert.equal(r.id,'supply-filter');assert.equal(r.from.padId,'U1:1');assert.equal(r.to.padId,'C1:1');
    assert.equal(r.source,'contract.extensions.pcbLayout.relations[0]');
    const weights=c.problem.links.map(l=>l.weight).sort((a,b)=>a-b);
    assert.deepEqual(weights,[...expectedWeights].sort((a,b)=>a-b),JSON.stringify(change));
    assert.equal(new Set(c.problem.links.map(l=>l.id)).size,c.problem.links.length);
    assert.equal(c.problem.links.some(l=>l.id===r.composition.objectiveId),sourceRetained);
    assert.equal(c.objectiveComposition.relations[0].mode,change.merge??'inherit');
    assert.deepEqual(c.objectiveComposition.effectiveLinks.map(l=>l.weight).sort((a,b)=>a-b),weights);
  }
  assert.deepEqual(f,{...original,config:{...original.config,comparisonWeights:{...original.config.comparisonWeights,bypass:8}}});
});
test('reference follows the compiled objective identity when an existing exact link is reversed',()=>{
  const f=inputs();f.config.groups[2].links=[{a:'C1',aPin:'1',b:'U1',bPin:'1',nets:['SUPPLY']}];
  const c=compile(f,request({relations:[reference()]}));assert.equal(c.effectiveRelations[0].composition.objectiveId,'bypass:C1:1:U1:1:SUPPLY');
  assert.equal(c.scope.request.relations[0].from.ref,'U1');
});
test('stable references resolve provider physical pin mappings without copying logical pin names',()=>{
  const f=inputs();f.contract.components[0].bindings={easyedaPro:{pinMap:{'1':['A']}}};f.snapshot.pads[0].number='A';
  const c=compile(f,request({relations:[reference()]}));assert.equal(c.scope.request.relations[0].from.pin,'A');assert.equal(c.scope.request.relations[0].from.padId,'U1:1');
});
test('multi-pad source references retain every physical pad and the existing distance aggregation',()=>{
  const f=inputs();f.contract.components[0].bindings={easyedaPro:{pinMap:{'1':['A','B']}}};f.snapshot.pads[0].number='A';
  const p=structuredClone(f.snapshot.pads[0]);p.id='U1:B';p.number='B';p.x=5;p.bbox={minX:3,maxX:7,minY:-2,maxY:2};f.snapshot.pads.push(p);
  const c=compile(f,request({relations:[reference()]}));
  assert.deepEqual(c.scope.request.relations[0].from.pads.map(p=>p.padId),['U1:1','U1:B']);
  assert.equal(relationDistance(c.scope.model,c.baseline.plan.components,c.effectiveRelations[0]),145);
  const audit=auditFineCandidate(c.scope,c,c.baseline.plan);assert.equal(audit.relations[0].measurement.pairs.length,2);assert.equal(audit.relations[0].measurement.maximumPairMil,150);assert.match(audit.relations[0].acceptanceScope,/not all-pad connectivity/);
});
test('replacing one objective preserves all base hard limits and adds stricter comparison separately',()=>{
  const f=inputs();f.contract.extensions.pcbLayout.relations[0].maxDistanceMil=180;
  const c=compile(f,request({relations:[reference({merge:'replace-objective',weight:4,geometry:'bbox-center',maxDistanceMil:300,nonRegression:{toleranceMil:0},critical:true})]}));
  assert.ok(!c.problem.links.some(l=>l.id===c.effectiveRelations[0].composition.objectiveId));
  assert.equal(c.problem.links.find(l=>l.id==='fine-soft:supply-filter').weight,4);
  assert.ok(c.problem.limits.some(l=>l.maxMil===180));assert.ok(c.problem.limits.some(l=>l.id==='fine-hard:supply-filter'&&l.maxMil===300));
  const changed=structuredClone(c.baseline.plan);changed.components.find(p=>p.ref==='C1').x=200;
  const audit=auditFineCandidate(c.scope,c,changed);assert.equal(audit.sourceLimits[0].passed,false);assert.equal(audit.localAccepted,false);
});
test('a zero replacement weight disables only the named soft objective',()=>{
  const f=inputs();f.contract.extensions.pcbLayout.relations[0].maxDistanceMil=180;
  const c=compile(f,request({relations:[reference({merge:'replace-objective',weight:0})]}));
  assert.ok(!c.problem.links.some(l=>l.id.startsWith('bypass:')||l.id.startsWith('fine-soft:')));assert.ok(c.problem.limits.some(l=>l.maxMil===180));assert.ok(c.problem.nets.length);
});
test('referenced existing source caps bind critical acceptance without changing their geometry',()=>{
  const f=inputs();f.config.hard.pinDistanceLimits=[{id:'supply-cap',a:'U1',aPin:'1',b:'C1',bPin:'1',net:'SUPPLY',maxMil:180}];
  const c=compile(f,request({relations:[reference({critical:true})]})),audit=auditFineCandidate(c.scope,c,c.baseline.plan);
  assert.equal(audit.relations[0].coverage,'source-acceptance-rule');assert.equal(audit.relations[0].passed,true);assert.deepEqual(audit.unboundCritical,[]);
  assert.equal(audit.relations[0].sourceLimits[0].id,'supply-cap');
});
test('unbound critical references remain uncovered despite inherited soft objectives',()=>{
  const c=compile(inputs(),request({relations:[reference({critical:true})]}));
  assert.deepEqual(auditFineCandidate(c.scope,c,c.baseline.plan).unboundCritical,['supply-filter']);
});
test('explicit new physical goals at the same endpoints are retained instead of blindly deduplicated',()=>{
  const c=compile(inputs(),request({relations:[reference(),{id:'different-proxy',merge:'append-objective',from:{ref:'U1',pin:'1'},to:{ref:'C1',pin:'1'},geometry:'bbox-center',basis:'Separate declared physical metric',weight:2}]}));
  assert.ok(c.problem.links.some(l=>l.id==='fine-soft:different-proxy'));assert.equal(c.objectiveComposition.relations[1].mode,'explicit-addition');
});
test('unknown or duplicate base identities and conflicting explicit endpoint fields reject early',()=>{
  for(const [relations,error]of [[[reference({relationId:'unknown'})],/FINE_UNKNOWN_BASE_RELATION/],[[reference(),reference({id:'second'})],/FINE_DUPLICATE_BASE_RELATION/],[[reference({from:{ref:'C1',pin:'1'}})],/FINE_BASE_ENDPOINT_CONFLICT/],[[reference({net:'wrong'})],/FINE_BASE_ENDPOINT_CONFLICT/]])assert.throws(()=>compile(inputs(),request({relations})),error);
});
test('inherit cannot silently change weight, metric or disable source objectives',()=>{
  for(const relation of [reference({weight:2}),reference({geometry:'bbox-center'})])assert.throws(()=>compile(inputs(),request({relations:[relation]})),/FINE_INHERIT_OBJECTIVE_CONFLICT/);
  assert.throws(()=>compile(inputs(),request({relations:[reference()],objective:{retainSource:false}})),/FINE_BASE_OBJECTIVE_DISABLED/);
  assert.throws(()=>compile(inputs(),request({relations:[reference({merge:'replace-objective'})]})),/FINE_RELATION_WEIGHT_REQUIRED/);
});
test('invalid merge and geometry do not acquire implicit meanings',()=>{
  assert.throws(()=>compile(inputs(),request({relations:[reference({merge:'auto'})]})),/FINE_INVALID_RELATION_MERGE/);
  assert.throws(()=>compile(inputs(),request({relations:[reference({merge:'replace-objective',weight:1,geometry:'routed-length'})]})),/FINE_INVALID_RELATION_GEOMETRY/);
});
test('legacy endpoint requests keep additive bbox-centre semantics and original weights',()=>{
  const old={id:'old',from:{ref:'U1',pin:'1'},to:{ref:'C1',pin:'1'},basis:'Existing request',weight:3};
  const c=compile(inputs(),request({movableRefs:['C1'],relations:[old]}));
  assert.ok(c.problem.links.some(l=>l.id.startsWith('bypass:')));assert.equal(c.problem.links.find(l=>l.id==='fine-soft:old').weight,3);
  assert.equal(c.effectiveRelations[0].composition.mode,'legacy-addition');assert.equal(c.problem.links.find(l=>l.id==='fine-soft:old').left[0].geometry,'bbox-center');
});
test('pad-position and bbox-centre goals use their declared distinct geometry in audit and compile',()=>{
  const f=inputs();f.snapshot.pads[1].bbox={minX:149,maxX:153,minY:-2,maxY:2};
  const c=compile(f,request({relations:[reference(),{id:'centre',merge:'append-objective',from:{ref:'U1',pin:'1'},to:{ref:'C1',pin:'1'},basis:'Offset observed pad rectangle',weight:1}]}));
  assert.equal(relationDistance(c.scope.model,c.baseline.plan.components,c.effectiveRelations[0]),150);
  assert.equal(relationDistance(c.scope.model,c.baseline.plan.components,c.effectiveRelations[1]),151);
});
test('input preparation, selection and composition leave the supplied frozen data unchanged',()=>{
  const f=inputs(),r=request({relations:[reference({merge:'replace-objective',weight:2})]}),before=JSON.stringify([f,r]);compile(f,r);assert.equal(JSON.stringify([f,r]),before);
});
test('scope relation selection derives existing related bases without adding another objective',()=>{
  const f=inputs(),old=compile(f),c=compile(f,request({relationSelection:'scope'}));
  assert.deepEqual(c.scope.selection.relations.derivedIds,['supply-filter']);assert.deepEqual(c.problem.links,old.problem.links);
  assert.equal(c.effectiveRelations[0].merge,'inherit');assert.deepEqual(compile(f).scope.request.relations,[]);
});
test('explicit replacement suppresses only its implicit inherited duplicate',()=>{
  const c=compile(inputs(),request({relationSelection:'scope',relations:[reference({merge:'replace-objective',weight:2})]}));
  assert.deepEqual(c.scope.selection.relations.derivedIds,[]);assert.equal(c.effectiveRelations.length,1);assert.equal(c.problem.links.find(l=>l.id==='fine-soft:supply-filter').weight,2);
});
test('scope derivation does not release outside objects or select unrelated frozen-only relations',()=>{
  const f=withNeighbor();f.contract.extensions.pcbLayout.relations.push({id:'outside',kind:'power-path',from:{ref:'U1',pin:'1'},to:{ref:'R1',pin:'1'},net:'SUPPLY',basis:'Separate frozen-only relationship'});
  const c=compile(f,request({relationSelection:'scope'}));assert.deepEqual(c.scope.selection.relations.derivedIds,['supply-filter']);assert.deepEqual(c.scope.request.allowedNeighborRefs,[]);assert.equal(c.problem.entities.find(e=>e.ref==='R1').fixed,true);
});
test('explicit new same-endpoint goal is retained alongside a derived base',()=>{
  const c=compile(inputs(),request({relationSelection:'scope',relations:[{id:'new-physical-goal',merge:'append-objective',from:{ref:'U1',pin:'1'},to:{ref:'C1',pin:'1'},basis:'Explicit additional physical proxy',weight:2}]}));
  assert.equal(c.effectiveRelations.length,2);assert.ok(c.problem.links.some(l=>l.id==='fine-soft:new-physical-goal'));assert.ok(c.problem.links.some(l=>l.id.startsWith('bypass:')));
});
test('scope relation selection must retain base objectives and have a known mode',()=>{
  assert.throws(()=>compile(inputs(),request({relationSelection:'scope',objective:{retainSource:false}})),/FINE_BASE_OBJECTIVE_DISABLED/);
  assert.throws(()=>compile(inputs(),request({relationSelection:'automatic-everything'})),/FINE_RELATION_SELECTION/);
});
