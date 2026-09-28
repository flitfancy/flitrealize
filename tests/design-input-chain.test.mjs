import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadAction } from './helpers/action-harness.mjs';
import { renderFacts } from '../scripts/handoff-sync.mjs';
import { loadLayoutProject, readJson } from '../scripts/pcb-layout/pcb-layout-project.mjs';
import { prepareLayoutInputs } from '../scripts/pcb-layout/pcb-layout-prepare.mjs';
import { inspectCandidate } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';

const example = fileURLToPath(new URL('../assets/pcb-layout/minimal-project/', import.meta.url));
const audit = await loadAction('schematic-contract-audit');

test('Contract, readable facts and PCB preparation share one design without promoting its evidence', async () => {
  const input = await loadLayoutProject(example);
  input.snapshot = await readJson(new URL('../assets/pcb-layout/minimal-project/snapshot.json', import.meta.url));
  const { contract } = input;
  contract.components[0].pins[0].safeDefault = 'Supply must be stable before enabling the load';
  contract.constraints.push({
    id: 'return-path', type: 'routing', appliesTo: [{ kind: 'net', id: 'RETURN' }],
    requirement: 'Preserve a continuous return path.', evidenceState: 'PASSED',
  });
  const original = structuredClone(input);
  const audited = await audit(null, { contract });
  assert.equal(audited.status, 'conditional');
  assert.equal(audited.counts.blockerCount, 0);
  assert.equal(audited.coverage.electricalCorrectness, false);
  const facts = renderFacts({ contract });
  assert.ok(facts.includes(contract.components[0].identity.description));
  assert.ok(facts.includes(contract.components[0].pins[0].safeDefault));
  assert.ok(facts.includes('| 1 | 未提供 | Supply | SUPPLY |'), 'physical mapping is not invented from a logical pin identifier');

  const prepared = prepareLayoutInputs(input);
  assert.equal(prepared.state.ready, true, JSON.stringify(prepared.diagnostics));
  assert.equal(prepared.coverage.relations[0].status, 'compiled');
  assert.equal(prepared.coverage.requirements.find(r => r.id === 'bypass-locality').status, 'partial');
  assert.equal(prepared.coverage.requirements.find(r => r.id === 'return-path').status, 'unbound');
  assert.equal(prepared.model.limits.length, 0, 'prose does not introduce a guessed distance limit');
  assert.equal(inspectCandidate(prepared.model).validation.valid, true);
  assert.deepEqual(input, original);

  contract.components[0].pins[0].number = 'VDD';
  contract.components[0].bindings = { easyedaPro: { pinMap: { VDD: ['1'], '2': ['2'] } } };
  contract.nets[0].endpoints[0].pin = 'VDD';
  contract.extensions.pcbLayout.relations[0].from.pin = 'VDD';
  const mappedAudit = await audit(null, { contract });
  assert.equal(mappedAudit.counts.blockerCount, 0);
  const mapped = prepareLayoutInputs(input);
  assert.equal(mapped.state.ready, true, JSON.stringify(mapped.diagnostics));
  assert.ok(renderFacts({ contract }).includes('| VDD | 1 | Supply | SUPPLY |'));
  const baselineMetrics = inspectCandidate(prepared.model).metrics;
  assert.ok(baselineMetrics.groups.bypass.mil > 0);
  assert.deepEqual(inspectCandidate(mapped.model).metrics.groups, baselineMetrics.groups);
  assert.equal(mapped.contract.constraints[0].evidenceState, 'OPEN');
  assert.equal(mapped.contract.constraints[1].evidenceState, 'PASSED');
});
