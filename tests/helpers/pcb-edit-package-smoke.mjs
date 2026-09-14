import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { pcbFixture } from './pcb-tools-fixture.mjs';
import { pcbActionExecutor } from './pcb-edit-fixture.mjs';

const extracted = process.argv[2];
const { runPcbEdit } = await import(pathToFileURL(join(extracted, 'scripts/pcb-edit.mjs')));
const projectRoot = await mkdtemp(join(tmpdir(), 'flitrealize-pcb-edit-package-'));
try {
  const { scene, eda, target } = pcbFixture();
  const invoke = pcbActionExecutor(eda, join(extracted, 'scripts/actions/easyeda-pro'));
  const inputFile = join(projectRoot, 'input.json');
  await writeFile(inputFile, JSON.stringify({ ...target, rules: [{ nets: ['PWR'], color: '#112233' }] }));
  const options = { projectRoot, inputFile, action: 'pcb-net-color', invoke };
  assert.equal((await runPcbEdit(options)).status, 'planned');
  assert.equal(scene.writes.length, 0);
  eda.pcb_Document.save = async () => false;
  const failed = await runPcbEdit({ ...options, apply: true });
  assert.equal(failed.status, 'save-failed'); assert.equal(scene.writes.length, 2);
  assert.equal(JSON.parse(await readFile(failed.resumeSaveReport, 'utf8')).response.result.status, 'applied');
  eda.pcb_Document.save = async () => { scene.saves++; return true; };
  const recovered = await runPcbEdit({ projectRoot, invoke, apply: true, resumeSave: failed.reportFile });
  assert.equal(recovered.status, 'verified'); assert.equal(recovered.saved, true);
  assert.equal(scene.writes.length, 2); assert.equal(scene.saves, 1);
  assert.deepEqual(recovered.steps.map(step => step.mode), ['verify', 'save', 'verify']);
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}
console.log('Packaged PCB wrapper plan/apply/verify/save recovery passed (isolated simulation only).');
