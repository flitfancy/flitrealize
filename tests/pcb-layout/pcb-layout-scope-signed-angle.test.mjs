import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFixture } from '../helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { scopeLayoutModel } from '../../scripts/pcb-layout/pcb-layout-scope.mjs';
import { normalizeFineRequest } from '../../scripts/pcb-layout/fine/request.mjs';
import { compileFineProblem } from '../../scripts/pcb-layout/fine/compile.mjs';

function fixedModel(rotation) {
  const input = prepareFixture();
  input.config.hard.boardBounds = { minX: -100, minY: -100, maxX: 400, maxY: 240 };
  input.snapshot.components[0].rotation = rotation;
  input.config.hard.fixed = [{ ref: 'U1', x: 0, y: 0, rotation }];
  const prepared = prepareLayoutInputs(input);
  assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  return prepared.model;
}

test('signed hard.fixed angles remain exact while comparing canonical rotation domains', () => {
  for (const rotation of [-90, -90.00000000000001, -450, 270, -180, -270, 360]) {
    const model = fixedModel(rotation);
    const before = structuredClone(model.snapshot);
    const scope = normalizeFineRequest(model, { schemaVersion: 1, blockId: 'supply', movableRefs: ['C1'], region: { mode: 'available-space', basis: 'Test the unchanged native fixed context' } });
    const compiled = compileFineProblem(scope);
    assert.equal(scope.model.fixed.get('U1').rotation, rotation);
    assert.equal(compiled.problem.entities.find(e => e.ref === 'U1').variants[0].rotation, rotation);
    assert.deepEqual(model.snapshot, before);
  }
});

test('a truly disallowed fixed rotation still fails', () => {
  const model = fixedModel(-90);
  model.allowedRotations.set('U1', [0, 180]);
  assert.throws(() => scopeLayoutModel(model), /INVALID_OPEN_FIXED_POSE U1/);
});

test('fixed coordinate changes and non-finite poses still fail', () => {
  const model = fixedModel(-90);
  for (const key of ['x', 'y']) {
    const pose = { ...model.fixed.get('U1'), [key]: 1 };
    assert.throws(() => scopeLayoutModel(model, { contextPlacements: [pose] }), /OPEN_CONTEXT_FIXED_POSE_CONFLICT U1/);
    assert.throws(() => scopeLayoutModel(model, { gaugeRef: 'U1', gaugePose: pose }), /OPEN_GAUGE_FIXED_POSE_CONFLICT U1/);
  }
  for (const key of ['x', 'y', 'rotation']) for (const value of [NaN, Infinity, -Infinity]) {
    const invalid = fixedModel(-90);
    invalid.fixed.get('U1')[key] = value;
    assert.throws(() => scopeLayoutModel(invalid), /INVALID_OPEN_FIXED_POSE U1/);
  }
});
