import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBoard } from '../scripts/providers/easyeda-pro/pcb-layout-board.mjs';
import { resolveBoardBounds, boardContains } from '../scripts/pcb-layout/pcb-layout-board.mjs';
import { prepareFixture } from './helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate, buildCandidate, buildEdgeCandidate, runSearch } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { generateInitialProposals } from '../scripts/pcb-layout/pcb-layout-initial-proposals.mjs';
import { prepareLayoutStarts } from '../scripts/pcb-layout/pcb-layout-starts.mjs';
import { transformBox } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';

const bounds = { minX: -50, minY: -50, maxX: 250, maxY: 100 };
const outline = b => [{ id: 'board', path: [b.minX, b.minY, 'L', b.minX, b.maxY, b.maxX, b.maxY, b.maxX, b.minY, b.minX, b.minY] }];
const prepared = f => { const p = prepareLayoutInputs(f); assert.equal(p.state.ready, true, JSON.stringify(p.diagnostics)); return p; };

test('native rectangular outline is decoded exactly; unsupported shapes are never approximated', () => {
  assert.deepEqual(decodeBoard(outline(bounds)), { status: 'rectangle', bounds });
  assert.deepEqual(decodeBoard([{path:[-50,-50,250,-50,250,100,-50,100,'Z']}]),{status:'rectangle',bounds});
  assert.deepEqual(decodeBoard([]), { status: 'none' });
  for (const paths of [[{path:[0,0,'L',20,0,20,20,0,20]}], [{path:[0,0,'L',20,0,10,20,0,0]}], [{path:[0,0,'A',10,20,10,0,0]}], [...outline(bounds), ...outline(bounds)], [{id:'line',kind:'Line'}]]) assert.equal(decodeBoard(paths).status, 'unsupported');
});

test('explicit and native board definitions agree or produce an actionable conflict', () => {
  assert.deepEqual(resolveBoardBounds({status:'none'}).bounds, null);
  assert.deepEqual(resolveBoardBounds({status:'none'}, bounds).bounds, bounds);
  assert.deepEqual(resolveBoardBounds(decodeBoard(outline(bounds)), bounds, bounds).sources, ['native','config','mechanical']);
  assert.throws(() => resolveBoardBounds(decodeBoard(outline(bounds)), {...bounds,maxX:300}), /BOARD_BOUNDS_MISMATCH/);
  assert.throws(() => resolveBoardBounds({status:'unsupported'}, bounds), /BOARD_OUTLINE_UNSUPPORTED/);
  assert.throws(() => resolveBoardBounds(null, {...bounds,minX:Infinity}), /INVALID_BOARD_BOUNDS/);
});

test('preparation derives a fixed native board without changing the source inputs', () => {
  const f = prepareFixture(); f.snapshot.outlines = outline(bounds);
  const before = structuredClone(f), p = prepared(f);
  assert.deepEqual(p.model.config.hard.boardBounds, bounds);
  assert.deepEqual(p.model.mechanical.boardBounds, bounds);
  assert.equal(inspectCandidate(p.model).validation.valid, true);
  assert.deepEqual(f, before);
});

test('malformed or conflicting board dimensions are input errors, not repairable placement problems', () => {
  for(const supplied of [{...bounds,maxX:bounds.minX},{...bounds,maxX:300}]) {
    const f=prepareFixture();f.snapshot.outlines=outline(bounds);f.config.hard.boardBounds=supplied;
    const result=prepareLayoutInputs(f);
    assert.equal(result.state.ready,false);
    assert.equal(result.state.input,'invalid');
    assert.ok(result.diagnostics.some(d=>['INVALID_BOARD_BOUNDS','BOARD_BOUNDS_MISMATCH'].includes(d.code)));
  }
});

test('board containment checks pads and labels, and an existing violation remains inspectable', () => {
  const f = prepareFixture(); f.config.hard.boardBounds = {...bounds,maxY:20};
  const p = prepared(f), current = inspectCandidate(p.model);
  assert.ok(current.validation.issues.some(i => i.code === 'BOARD_BOUNDARY_VIOLATION'));
  const repaired = buildCandidate(p.model, f.snapshot.components);
  assert.equal(repaired.validation.valid, true, JSON.stringify(repaired.validation.issues));
  assert.ok(repaired.plan.labels.every(l => boardContains(p.model.config.hard.boardBounds,l.bbox)));
  f.snapshot.pads[0].bbox.minX = -70;
  assert.ok(inspectCandidate(prepared(f).model).validation.issues.some(i=>i.code==='BOARD_BOUNDARY_VIOLATION' && i.kind==='pad'));
});

test('edge construction and search use the fixed board instead of expanding the component envelope', () => {
  const f = prepareFixture(); f.config.hard.boardBounds = bounds;
  f.config.componentFeatures = [{ref:'U1',edge:{sides:['left']}}];
  const p = prepared(f), first = buildEdgeCandidate(p.model,f.snapshot.components);
  assert.equal(first.validation.valid,true,JSON.stringify(first.validation.issues));
  assert.equal(first.plan.components.find(c=>c.ref==='U1').body.minX,bounds.minX);
  assert.deepEqual(first.validation.edge.envelope,bounds);
  const searched=runSearch(p.model,f.config.search.profiles[0],4,first.plan);
  assert.equal(searched.validation.valid,true);
  assert.deepEqual(searched.validation.edge.envelope,bounds);
});

test('an undersized board reports infeasibility while fixed positions remain unchanged', () => {
  const f=prepareFixture(); f.config.hard.boardBounds={minX:0,minY:0,maxX:5,maxY:5};
  f.snapshot.components[0].locked=true;
  const p=prepared(f), result=buildCandidate(p.model,f.snapshot.components,undefined,{}, {maxRelocationMil:5});
  assert.equal(result.validation.valid,false);
  assert.ok(result.validation.issues.some(i=>i.code==='BOARD_BOUNDARY_VIOLATION'));
  assert.equal(result.plan.components.find(c=>c.ref==='U1').x,0);
});

test('fresh starts are constructed inside the board even when the source positions are scattered', () => {
  const f=prepareFixture();f.config.hard.boardBounds=bounds;
  f.config.componentFeatures=[{ref:'U1',edge:{sides:['left']}}];
  const p=prepared(f), proposals=generateInitialProposals(p.model,{seed:9,count:3,packingGapMil:8});
  for(const proposal of proposals) {
    for(const c of proposal.components) assert.ok(boardContains(bounds,transformBox(p.model.components.get(c.ref).bbox,p.model.components.get(c.ref),c)));
    assert.equal(transformBox(p.model.components.get('U1').bbox,p.model.components.get('U1'),proposal.components.find(c=>c.ref==='U1')).minX,bounds.minX);
  }
  const starts=prepareLayoutStarts(p.model,{mode:'fresh',count:1,seed:9,packingGapMil:8,maxRepairMil:50});
  assert.equal(starts.accepted,1,JSON.stringify(starts.attempts));
  assert.ok(starts.starts[0].plan.labels.every(l=>boardContains(bounds,l.bbox)));
});

test('packing failure is reported in start diagnostics without enlarging an impossible board', () => {
  const f=prepareFixture();f.config.hard.boardBounds={minX:0,minY:0,maxX:5,maxY:5};
  const p=prepared(f), starts=prepareLayoutStarts(p.model,{mode:'fresh',count:1,attemptsPerStart:1});
  assert.equal(starts.accepted,0);
  assert.equal(starts.exhausted,true);
  assert.match(starts.attempts[0].error,/PACKING_FAILED/);
  assert.deepEqual(p.model.config.hard.boardBounds,f.config.hard.boardBounds);
});
