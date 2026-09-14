import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { batchFixture } from './component-batch-fixture.mjs';

const extracted = process.argv[2];
const { runComponentBatch } = await import(pathToFileURL(join(extracted, 'scripts/schematic-components.mjs')));
const manifest = JSON.parse(await readFile(join(extracted, 'scripts/actions/manifest.json'), 'utf8'));
const cleanups = [];
const f = await batchFixture({ after: fn => cleanups.push(fn) }, 6);
const functions = new Map();
const invoke = async (name, input) => {
  if (!functions.has(name)) {
    const code = await readFile(join(extracted, 'scripts/actions', manifest.actions[name].file), 'utf8');
    functions.set(name, new (Object.getPrototypeOf(async function () {}).constructor)('eda', 'flitrealizeInput', code));
  }
  return functions.get(name)(f.eda, input);
};
try {
  f.eda.failCreateAt = 4;
  let runDir;
  await assert.rejects(runComponentBatch({ projectRoot: f.root, inputFile: f.inputFile, apply: true, invoke }), error => { runDir = error.runDir; return error.code === 'ACTION_NOT_COMPLETED'; });
  assert.equal(f.eda.records.length, 3);
  const beforeIds = f.eda.records.map(row => row.id);
  f.eda.failCreateAt = null;
  const result = await runComponentBatch({ projectRoot: f.root, resume: runDir, apply: true, invoke });
  assert.equal(result.status, 'placed-saved');
  assert.equal(result.placedCount, 6);
  assert.deepEqual(f.eda.records.slice(0, 3).map(row => row.id), beforeIds);
  assert.equal(f.eda.saveCount, 1);
  assert.equal(f.eda.drcCount, 0);
  console.log('[PASS] packaged batch orchestration resumes only missing components in isolated EDA mock');
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
