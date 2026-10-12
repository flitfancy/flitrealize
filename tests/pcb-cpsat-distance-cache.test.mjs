import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFixture } from './helpers/pcb-layout-prepare-fixture.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { normalizeFineRequest } from '../scripts/pcb-layout/fine/request.mjs';
import { solveFineLabels } from '../scripts/pcb-layout/fine/labels.mjs';
import { independentLabelGeometry } from '../scripts/pcb-layout/fine/label-geometry.mjs';

test('real label solver keeps each repeated centre endpoint bound to its own distant owner', {
  skip: !process.env.FLITREALIZE_CPSAT_PYTHON && 'Existing OR-Tools runtime required'
}, async () => {
  const input = prepareFixture();
  input.config.hard.boardBounds = { minX: 100, minY: -1800, maxX: 2000, maxY: -200 };
  for (const c of input.snapshot.components) {
    const dx = c.ref === 'U1' ? 400 : 1200, dy = -900;
    c.x += dx; c.y += dy;
    const pads = input.snapshot.pads.filter(p => p.owner === c.ref);
    const labels = input.snapshot.items.filter(l => l.owner === c.ref);
    for (const b of [c.bbox, ...pads.map(p => p.bbox), ...labels.map(l => l.original.bbox)]) {
      for (const key of ['minX', 'maxX']) b[key] += dx;
      for (const key of ['minY', 'maxY']) b[key] += dy;
    }
    for (const p of pads) { p.x += dx; p.y += dy; }
    for (const l of labels) { l.original.x += dx; l.original.y += dy; }
  }
  const prepared = prepareLayoutInputs(input);
  assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  const request = { schemaVersion: 1, blockId: 'supply', movableRefs: ['U1', 'C1'],
    region: { mode: 'available-space', basis: 'Distant owners and repeated local endpoint identifiers with a nonzero board origin.' },
    labels: { mode: 'separate', clearanceMil: 8, maxOwnerDistanceMil: 60 },
    baselinePolicy: 'retain-outside-issues', objective: { retainSource: false } };
  const scope = normalizeFineRequest(prepared.model, request);
  const body = inspectCandidate(scope.model).plan;
  const result = await solveFineLabels(scope, body,
    { resolutionMil: .5, timeLimitSeconds: 5, workers: 1, seed: 17, displacementWeight: 0 },
    { pythonPath: process.env.FLITREALIZE_CPSAT_PYTHON });
  assert.ok(['FEASIBLE', 'OPTIMAL'].includes(result.status), JSON.stringify(result));
  const checked = independentLabelGeometry({ components: body.components, pads: input.snapshot.pads,
    labels: result.labels, clearanceMil: 8, maxOwnerDistanceMil: 60 });
  assert.equal(checked.valid, true, JSON.stringify(checked.issues));
});
