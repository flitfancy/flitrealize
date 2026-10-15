import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAction } from '../helpers/action-harness.mjs';
import { checkCreateRecovery } from '../helpers/create-action-recovery.mjs';

const netFlagAction = await loadAction('schematic-net-flag', 'easyeda-pro');

function createMockEda(hydration = null) {
  let sequence = 0;
  const components = [];
  const imports = [];
  let records = [
    { head: { type: 'DOCHEAD', id: 'head' }, payload: { grid: 5, custom: { version: 7 } } },
    { head: { type: 'TEXT', id: 'untouched-note' }, payload: { text: 'Keep this note', x: -40, y: 25, fontSize: 13 } },
    { head: { type: 'CUSTOM', id: 'unknown-record' }, payload: { opaque: ['keep', { nested: true }] } },
  ];
  const payload = id => records.find(record => record.head.id === id)?.payload ?? {};
  function create(kind, net, x, y, rotation, mirror) {
    const id = `flag-${++sequence}`;
    records.push(
      { head: { type: 'COMPONENT', id, customHeader: 'retained' }, payload: { componentType: kind, net, x, y, rotation, mirror, custom: { source: 'fixture' } } },
      { head: { type: 'ATTR', id: `attr-${id}`, customHeader: 3 }, payload: { parentId: id, key: 'Name', value: net,
        valueVisible: true, keyVisible: true, x: x + 1.25, y: y - 2.5, fontSize: 11, align: 'LEFT', custom: { color: '#123456', keep: ['extra'] } } },
    );
    if (hydration) {
      records.find(record => record.head.id === id).payload.attrs = { DeviceName: null, other: 'keep' };
      records.push(
        { head: { type: 'ATTR', id: `device-${id}` }, payload: { parentId: id, key: 'Device', value: 'device-native' } },
        { head: { type: 'ATTR', id: `relevance-${id}` }, payload: { parentId: id, key: 'Relevance', value: '[]', zIndex: null } },
      );
    }
    const component = {
      getState_PrimitiveId: () => id, getState_Designator: () => '',
      getState_Net: () => payload(id).net, getState_ComponentType: () => payload(id).componentType,
      getState_X: () => payload(id).x, getState_Y: () => payload(id).y,
      getState_Rotation: () => payload(id).rotation, getState_Mirror: () => payload(id).mirror,
    };
    components.push(component);
    return component;
  }
  function source() {
    return records.map(record => `${JSON.stringify(record.head)}||${JSON.stringify(record.payload)}|`).join('\n');
  }
  return {
    imports,
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'doc-flags', documentType: 1, parentProjectUuid: 'project' }; } },
    sys_FileManager: {
      async getDocumentSource() { return source(); },
      async setDocumentSource(value) {
        imports.push({ before: source(), after: value });
        records = value.split(/\r?\n/).filter(Boolean).map(line => {
          const split = line.indexOf('||');
          const head = JSON.parse(line.slice(0, split));
          const payload = JSON.parse(line.slice(split + 2).replace(/\|$/, ''));
          return { head, payload };
        });
        if (hydration) for (const record of records) {
          if (record.head.type === 'COMPONENT') {
            record.payload.attrs.DeviceName = JSON.stringify({ name: 'Ground-GND', source: '', uuid: hydration === 'wrong-device' ? 'other-device' : 'device-native' });
            if (hydration === 'moved') record.payload.x += 1;
          }
          if (record.head.type === 'ATTR' && record.payload.key === 'Relevance') record.payload.zIndex = 0;
        }
        return true;
      },
    },
    sch_PrimitiveComponent: {
      async getAll() { return [...components]; },
      async createNetFlag(identification, net, x, y, rotation, mirror) { return create(`flag:${identification}`, net, x, y, rotation, mirror); },
      async createNetPort(direction, net, x, y, rotation, mirror) { return create(`port:${direction}`, net, x, y, rotation, mirror); },
      async delete(ids) {
        const selected = new Set(ids);
        for (let index = components.length - 1; index >= 0; index -= 1) {
          if (selected.has(components[index].getState_PrimitiveId())) components.splice(index, 1);
        }
        records = records.filter(record => !selected.has(record.head.id) && !selected.has(record.payload.parentId));
        return true;
      },
    },
  };
}

test('marker creation, hidden names, verification and rollback preserve imported source fields', async () => {
const eda = createMockEda();
await eda.sch_PrimitiveComponent.createNetFlag('Power', 'EXISTING', 0, 0, 0, false);
const originalSource = await eda.sys_FileManager.getDocumentSource();
const planned = await netFlagAction(eda, {
  mode: 'plan',
  expectedDocumentUuid: 'doc-flags',
  items: [
    { kind: 'netFlag', identification: 'Ground', net: 'GND', x: 100, y: 200, rotation: 0, mirror: false, showName: false },
    { kind: 'netPort', direction: 'OUT', net: 'VOUT', x: 300, y: 200, rotation: 180, mirror: false, showName: false },
  ],
});
assert.equal(planned.status, 'planned');
assert.equal(planned.analysis.itemCount, 2);
assert.ok(planned.applyRequest);

const applied = await netFlagAction(eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.created.length, 2);
assert.equal(applied.saved, false);
assert.match(await eda.sys_FileManager.getDocumentSource(), /"valueVisible":false/);
assert.equal(eda.imports.length, 1);
const parseRecords = source => source.split(/\r?\n/).filter(Boolean).map(line => {
  const split = line.indexOf('||');
  return { head: JSON.parse(line.slice(0, split)), payload: JSON.parse(line.slice(split + 2).replace(/\|$/, '')) };
});
const beforeImport = parseRecords(eda.imports[0].before), afterImport = parseRecords(await eda.sys_FileManager.getDocumentSource());
assert.deepEqual(afterImport.map(record => record.head.id), beforeImport.map(record => record.head.id));
const createdIds = new Set(applied.created.map(item => item.primitiveId));
for (const [index, before] of beforeImport.entries()) {
  const expected = structuredClone(before);
  if (expected.head.type === 'ATTR' && expected.payload.key === 'Name' && createdIds.has(expected.payload.parentId)) {
    assert.equal(expected.payload.fontSize, 11);
    assert.equal(expected.payload.align, 'LEFT');
    assert.deepEqual(expected.payload.custom, { color: '#123456', keep: ['extra'] });
    expected.payload.valueVisible = false;
    expected.payload.keyVisible = false;
  }
  assert.deepEqual(afterImport[index], expected, `Only requested visibility may change in ${before.head.id}`);
}

const verified = await netFlagAction(eda, {
  mode: 'verify', expectedDocumentUuid: 'doc-flags', created: applied.created,
});
assert.equal(verified.status, 'verified');

const rolledBack = await netFlagAction(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');
assert.equal(await eda.sys_FileManager.getDocumentSource(), originalSource);
});

test('desktop marker cache hydration is accepted only for the unchanged device and geometry', async () => {
  for (const mode of ['normal', 'wrong-device', 'moved']) {
    const eda = createMockEda(mode);
    const plan = await netFlagAction(eda, { mode: 'plan', expectedDocumentUuid: 'doc-flags', items: [
      { kind: 'netFlag', identification: 'Ground', net: 'GND', x: 100, y: 200, showName: false },
    ] });
    const result = await netFlagAction(eda, plan.applyRequest);
    assert.equal(result.status, mode === 'normal' ? 'applied' : 'rolled-back');
    if (mode !== 'normal') assert.equal(result.error.code, 'EXECUTION_SOURCE_CHANGED');
  }
});

test('wrong marker target and oversized batches block planning', async () => {
const mismatch = await netFlagAction(createMockEda(), {
  mode: 'plan', expectedDocumentUuid: 'wrong-document',
  items: [{ kind: 'netFlag', identification: 'Power', net: 'VCC', x: 0, y: 0 }],
});
assert.equal(mismatch.status, 'planned-with-blockers');
assert.ok(mismatch.analysis.globalIssues.some((issue) => issue.code === 'DOCUMENT_MISMATCH'));

const oversized = await netFlagAction(createMockEda(), {
  mode: 'plan', expectedDocumentUuid: 'doc-flags',
  items: Array.from({ length: 31 }, (_, index) => ({ kind: 'netPort', direction: 'BI', net: `N${index}`, x: index * 10, y: 0 })),
});
assert.equal(oversized.status, 'planned-with-blockers');
assert.ok(oversized.analysis.globalIssues.some((issue) => issue.code === 'TOO_MANY_ITEMS' && issue.max === 30));
});

test('marker apply requires a planned request', async () => {
await assert.rejects(
  () => netFlagAction(createMockEda(), { mode: 'apply', items: [] }),
  (error) => error.code === 'INVALID_APPLY_REQUEST',
);
});

test('marker recovery does not delete objects with uncertain ownership', async () => {
await checkCreateRecovery({
  action: netFlagAction, createEda: createMockEda, namespace: 'sch_PrimitiveComponent', createMethod: 'createNetFlag',
  seed: mock => mock.sch_PrimitiveComponent.createNetFlag('Power', 'OTHER', 0, 0, 0, false),
  applyRequest: async mock => (await netFlagAction(mock, { mode: 'plan', expectedDocumentUuid: 'doc-flags', items: [
    { kind: 'netFlag', identification: 'Ground', net: 'GND', x: 100, y: 200 },
    { kind: 'netFlag', identification: 'Power', net: 'VCC', x: 300, y: 200 },
  ] })).applyRequest,
});
});
