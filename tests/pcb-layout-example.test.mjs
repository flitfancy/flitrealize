import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const example = fileURLToPath(new URL('../assets/pcb-layout/minimal-project/', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/pcb-layout.mjs', import.meta.url));
const execute = promisify(execFile);
const files = ['snapshot.json', 'design/PCB_LAYOUT_CONSTRAINTS.v1.json', 'design/SCHEMATIC_CONTRACT.v1.json', 'design/PCB_SILK_RULES.v1.json'];
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sourceHash = source => {
  let value = 2166136261;
  for (const character of source.split('\n').filter(line => !line.startsWith('{"type":"DOCHEAD"')).join('\n')) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
};

async function run(root, mode) {
  const options = ['--project-root', root, '--snapshot', path.join(root, 'snapshot.json'), '--mode', mode];
  if (mode === 'solve') options.push('--iterations', '4', '--starts', '1');
  const { stdout } = await execute(process.execPath, [cli, ...options], { cwd: tmpdir(), maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1);
}

test('minimal example declares synthetic provenance, complete logical pins and no native target', async () => {
  const snapshot = await read(path.join(example, 'snapshot.json'));
  const contract = await read(path.join(example, 'design/SCHEMATIC_CONTRACT.v1.json'));
  const mechanical = await read(path.join(example, 'design/PCB_SILK_RULES.v1.json'));
  assert.equal(snapshot.sourceKind, 'synthetic-example');
  assert.equal(snapshot.sourceHash, sourceHash(snapshot.source));
  assert.equal(snapshot.units, 'mil');
  assert.equal(snapshot.coordinateSystem, 'eda-y-up');
  assert.equal(mechanical.expectedProjectUuid, undefined);
  assert.equal(mechanical.expectedDocumentUuid, undefined);
  assert.deepEqual(snapshot.components.map(c => c.ref), ['U_LOAD', 'C_BYP']);
  assert.equal(contract.kind, 'flitrealize.schematic-contract');
  assert.ok(contract.components.every(c => c.includeInPcb && c.pinMapCoverage === 'complete' && c.pins.length === 2));
  const intent = contract.extensions.pcbLayout.relations[0];
  assert.equal(intent.kind, 'bypass');
  assert.equal(intent.requirementId, contract.constraints[0].id);
  assert.equal(intent.maxDistanceMil, undefined, 'the example must not imply a numeric electrical limit');
  for (const file of files) assert.match(await fs.readFile(path.join(example, file), 'utf8'), /illustrative-not-engineering-default/);
});

test('the full CLI prepares and solves a native rectangular example and draws its actual board', async () => {
  const temporary=await fs.mkdtemp(path.join(tmpdir(),'layout-example-board-'));
  try {
    await fs.cp(example,temporary,{recursive:true});
    const snapshot=await read(path.join(temporary,'snapshot.json'));
    const all=[...snapshot.components.map(c=>c.bbox),...snapshot.items.map(l=>l.original.bbox),...snapshot.pads.map(p=>p.bbox)];
    const board={minX:Math.min(...all.map(b=>b.minX))-200,minY:Math.min(...all.map(b=>b.minY))-200,maxX:Math.max(...all.map(b=>b.maxX))+200,maxY:Math.max(...all.map(b=>b.maxY))+200};
    snapshot.outlines=[{id:'example-board',path:[board.minX,board.minY,'L',board.minX,board.maxY,board.maxX,board.maxY,board.maxX,board.minY,board.minX,board.minY]}];
    await fs.writeFile(path.join(temporary,'snapshot.json'),JSON.stringify(snapshot));
    const configFile=path.join(temporary,'design/PCB_LAYOUT_CONSTRAINTS.v1.json'),config=await read(configFile);
    config.initialization.mode='fresh';
    await fs.writeFile(configFile,JSON.stringify(config));
    const prepared=await run(temporary,'prepare');
    assert.equal(prepared.state.ready,true);
    const receipt=await read(path.join(prepared.report,'layout-input.json'));
    assert.deepEqual(receipt.board.bounds,board);
    const solved=await run(temporary,'solve');
    assert.equal(solved.status,'candidates-ready-not-applied');
    const manifest=await read(path.join(solved.report,'manifest.json'));
    for(const row of manifest.candidates.filter(c=>c.name!=='baseline')) {
      const candidate=await read(path.join(solved.report,row.name+'.json'));
      assert.equal(candidate.validation.valid,true);
      assert.deepEqual(candidate.plan.boardBounds,board);
    }
    const html=await fs.readFile(path.join(solved.report,'comparison.html'),'utf8');
    assert.match(html,/class="board-outline"/);
    assert.match(html,/绿色实线为固定板框/);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)),path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith('layout-example-board-'));
    await fs.rm(temporary,{recursive:true,force:true});
  }
});

test('copied minimal project prepares and solves offline without modifying packaged assets', async () => {
  const originals = await Promise.all(files.map(file => fs.readFile(path.join(example, file), 'utf8')));
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'layout-example-'));
  const root = path.join(temporary, 'portable project');
  try {
    await fs.cp(example, root, { recursive: true });
    const prepared = await run(root, 'prepare');
    assert.equal(prepared.status, 'inputs-ready');
    assert.equal(prepared.nativeWrites, 0);
    assert.equal(prepared.state.ready, true);
    assert.equal(prepared.counts.components, 2);
    assert.deepEqual(prepared.coverage.requirements, { partial: 1 });
    const receipt = await read(path.join(prepared.report, 'layout-input.json'));
    assert.equal(receipt.preparation.coverage.relations[0].status, 'compiled');
    assert.equal(receipt.review.actualRoutingEvaluation, 'not-implemented');
    assert.equal(receipt.preparation.coverage.requirements[0].status, 'partial');
    const solved = await run(root, 'solve');
    assert.equal(solved.status, 'candidates-ready-not-applied');
    const summary = await read(path.join(solved.report, 'summary.json'));
    assert.equal(summary.applied, false);
    assert.equal(summary.nativeWrites, 0);
    const manifest = await read(path.join(solved.report, 'manifest.json'));
    assert.equal(manifest.synthetic, true);
    assert.ok(manifest.candidates.some(c => c.name !== 'baseline'));
    await assert.rejects(execute(process.execPath, [cli, '--project-root', root, '--mode', 'apply', '--window-id', 'not-a-live-window', '--from', solved.report, '--candidate', manifest.candidates.find(c => c.name !== 'baseline').name]), error => /SYNTHETIC_CANDIDATE_NOT_APPLICABLE/.test(error.stderr));
    for (const record of manifest.candidates.filter(c => c.name !== 'baseline')) {
      const candidate = await read(path.join(solved.report, record.name + '.json'));
      assert.equal(candidate.validation.valid, true);
      assert.ok(candidate.metrics.details.some(d => d.group === 'bypass'));
    }
    const input = await read(path.join(solved.report, 'inputs.json'));
    assert.equal(input.snapshot.sourceKind, 'synthetic-example');
    for (const [index, file] of files.entries()) assert.equal(await fs.readFile(path.join(example, file), 'utf8'), originals[index]);
    assert.equal(await fs.stat(path.join(example, 'evidence')).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith('layout-example-'));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
