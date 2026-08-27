import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  executeHostAction,
  loadManifest,
  resolveActionRequest,
  summarizeExecution,
} from '../scripts/action-runner.mjs';

const manifest = await loadManifest();
const descriptor = resolveActionRequest(manifest, 'schematic-contract-audit', { mode: 'inspect' }, false);
assert.equal(descriptor.runtime, 'host');
assert.equal(descriptor.domain, 'schematic');
assert.equal(descriptor.provider, null);
assert.equal(descriptor.mutates, false);

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/schematic-contract/${name}.json`, import.meta.url), 'utf8'));
}

async function audit(name, rawInput = false) {
  const contract = await loadFixture(name);
  const response = await executeHostAction(
    descriptor,
    rawInput ? contract : { mode: 'inspect', contract },
    { skillVersion: 'test-version', projectRoot: 'fixture-project' },
  );
  return response.result;
}

const valid = await audit('valid-minimal');
assert.equal(valid.status, 'passed');
assert.equal(valid.readOnly, true);
assert.equal(valid.counts.componentCount, 2);
assert.equal(valid.counts.netCount, 3);
assert.equal(valid.counts.blockerCount, 0);
assert.equal(valid.counts.warningCount, 0);
assert.equal(valid.counts.openCount, 0);
assert.equal(valid.coverage.electricalCorrectness, false);
assert.equal(valid.coverage.realizedSchematicComparison, false);

const validAgain = await audit('valid-minimal', true);
assert.equal(validAgain.fingerprint, valid.fingerprint);

const providerBinding = await audit('valid-provider-binding');
assert.equal(providerBinding.status, 'passed');
assert.equal(providerBinding.counts.opaqueProviderBindingCount, 1);

const conditional = await audit('conditional-unresolved');
assert.equal(conditional.status, 'conditional');
assert.equal(conditional.counts.blockerCount, 0);
assert.ok(conditional.counts.openCount >= 3);
assert.ok(conditional.issues.some((issue) => issue.code === 'IDENTITY_UNRESOLVED'));
assert.ok(conditional.issues.some((issue) => issue.code === 'FOOTPRINT_UNRESOLVED'));

const duplicate = await audit('invalid-duplicate-designator');
assert.equal(duplicate.status, 'blocked');
assert.ok(duplicate.issues.some((issue) => issue.code === 'DUPLICATE_IDENTITY'));

const badReference = await audit('invalid-endpoint-reference');
assert.equal(badReference.status, 'blocked');
assert.ok(badReference.issues.some((issue) => issue.code === 'UNKNOWN_COMPONENT_REFERENCE'));
assert.ok(badReference.issues.some((issue) => issue.code === 'UNKNOWN_PIN_REFERENCE'));

const noConnect = await audit('invalid-no-connect-wired');
assert.equal(noConnect.status, 'blocked');
assert.ok(noConnect.issues.some((issue) => issue.code === 'FORBIDDEN_PIN_CONNECTED'));

const response = { success: true, result: conditional };
const summary = summarizeExecution(response, descriptor, 'fixture-report.json', 'test-version');
assert.equal(summary.runtime, 'host');
assert.equal(summary.provider, null);
assert.equal(summary.status, 'conditional');
assert.equal(summary.fingerprints.fingerprint, conditional.fingerprint);
assert.equal(summary.counts.blockerCount, 0);
assert.equal(summary.counts.openCount, conditional.counts.openCount);
assert.equal(summary.issueCount, conditional.issues.length);

process.stdout.write('schematic contract audit tests passed\n');
