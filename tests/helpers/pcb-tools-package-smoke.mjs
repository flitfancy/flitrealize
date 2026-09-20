import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pcbFixture } from './pcb-tools-fixture.mjs';

const extracted = process.argv[2];
const { loadManifest, resolveActionRequest, executeHostAction } = await import(pathToFileURL(join(extracted, 'scripts/action-runner.mjs')));
const manifest = await loadManifest();
const AF = Object.getPrototypeOf(async function () {}).constructor;
for (const [name, input] of [
  ['pcb-net-color', { rules: [{ nets: ['PWR'], color: '#FF0000' }] }],
  ['pcb-trace-width', { rules: [{ net: 'PWR', primitiveIds: ['l1'], targetWidthMil: 25 }] }],
  ['pcb-placement', { boardBounds: { minX: 0, minY: 0, maxX: 1000, maxY: 500 }, lockedDesignators: ['U1'], reservedRegions: [], placements: [{ designator: 'R1', x: 200, y: 200 }] }],
]) {
  const { scene, eda, target } = pcbFixture(); if (name === 'pcb-placement') scene.lines = [];
  const file = join(extracted, 'scripts/actions', manifest.actions[name].file);
  const action = new AF('eda', 'flitrealizeInput', await readFile(file, 'utf8'));
  const planned = await action(eda, { mode: 'plan', ...target, ...input });
  assert.equal(planned.status, 'planned'); assert.equal(scene.writes.length, 0);
  assert.throws(() => resolveActionRequest(manifest, name, planned.applyRequest, false), { code: 'WRITE_AUTHORIZATION_REQUIRED' });
  const applied = await action(eda, { ...planned.applyRequest, ...(name === 'pcb-net-color' ? { save: true } : {}) });
  assert.equal(applied.status, 'applied');
  if (name === 'pcb-net-color') assert.equal(applied.saved, true);
  else {
    assert.equal(applied.saved, false);
    assert.equal((await action(eda, applied.verifyRequest)).status, 'verified');
    assert.equal((await action(eda, applied.saveRequest)).saved, true);
  }
  assert.equal(scene.saves, 1);
  if (name === 'pcb-trace-width') assert.deepEqual(scene.lines.map(l => l.lineWidth), [25, 6, 8]);
  if (name === 'pcb-placement') assert.deepEqual(scene.components.map(c => [c.x, c.y, c.rotation]), [[100, 100, 0], [200, 200, 90]]);
}
const descriptor = resolveActionRequest(manifest, 'pcb-routing-plan', {}, false);
const output = await executeHostAction(descriptor, { rules: { units: 'mil', classes: [{ name: 'power', priority: 1, nets: ['PWR'], widthMil: 25 }] } }, {});
assert.equal(output.result.status, 'generated');
assert.equal(output.result.capabilities.routed, false);
console.log('Packaged PCB layout/width/color/priority smoke passed (isolated simulation only).');
