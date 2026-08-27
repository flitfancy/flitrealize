import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const execute = await loadAction('eda-capabilities');
const eda = {
  dmt_SelectControl: {
    async getCurrentDocumentInfo() {
      return { uuid: 'pcb-test', tabId: 'pcb-test@project-test', documentType: 3, parentProjectUuid: 'project-test' };
    },
  },
  dmt_Project: {
    async getCurrentProjectInfo() {
      return { uuid: 'project-test', name: 'test/project', friendlyName: 'Test project' };
    },
  },
  pcb_PrimitiveVia: {
    async getAll() { return []; },
    async create() { return {}; },
    async delete() { return true; },
  },
};

const first = await execute(eda, { mode: 'inspect' });
const second = await execute(eda, { mode: 'inspect' });
assert.equal(first.status, 'inspected');
assert.equal(first.readOnly, true);
assert.equal(first.document.uuid, 'pcb-test');
assert.equal(first.capabilities['document.current'], true);
assert.equal(first.capabilities['via.create'], true);
assert.equal(first.capabilities['pour.create'], false);
assert.equal(first.capabilityFingerprint, second.capabilityFingerprint);
assert.ok(first.missing.includes('pour.create'));

process.stdout.write('eda capabilities tests passed\n');
