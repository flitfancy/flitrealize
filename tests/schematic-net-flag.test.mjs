import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';
import { checkCreateRecovery } from './helpers/create-action-recovery.mjs';

const netFlagAction = await loadAction('schematic-net-flag', 'easyeda-pro');

function createMockEda() {
  let sequence = 0;
  const components = [];
  const nameVisibility = new Map();
  function create(kind, net, x, y, rotation, mirror) {
    const id = `flag-${++sequence}`;
    const component = {
      getState_PrimitiveId: () => id, getState_Designator: () => '',
      getState_Net: () => net, getState_ComponentType: () => kind,
      getState_X: () => x, getState_Y: () => y,
      getState_Rotation: () => rotation, getState_Mirror: () => mirror,
    };
    components.push(component);
    nameVisibility.set(id, true);
    return component;
  }
  function source() {
    return components.flatMap((component) => {
      const id = component.getState_PrimitiveId();
      return [
        `${JSON.stringify({ type: 'COMPONENT', id })}||${JSON.stringify({ componentType: component.getState_ComponentType() })}|`,
        `${JSON.stringify({ type: 'ATTR', id: `attr-${id}` })}||${JSON.stringify({ parentId: id, key: 'Name', value: component.getState_Net(), valueVisible: nameVisibility.get(id) })}|`,
      ];
    }).join('\n');
  }
  return {
    dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: 'doc-flags', documentType: 1, parentProjectUuid: 'project' }; } },
    sys_FileManager: {
      async getDocumentSource() { return source(); },
      async setDocumentSource(value) {
        for (const line of value.split(/\r?\n/).filter(Boolean)) {
          const split = line.indexOf('||');
          const head = JSON.parse(line.slice(0, split));
          const payload = JSON.parse(line.slice(split + 2).replace(/\|$/, ''));
          if (head.type === 'ATTR' && payload.key === 'Name') nameVisibility.set(payload.parentId, payload.valueVisible !== false);
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
        for (const id of ids) nameVisibility.delete(id);
        return true;
      },
    },
  };
}

const eda = createMockEda();
await eda.sch_PrimitiveComponent.createNetFlag('Power', 'EXISTING', 0, 0, 0, false);
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

const verified = await netFlagAction(eda, {
  mode: 'verify', expectedDocumentUuid: 'doc-flags', created: applied.created,
});
assert.equal(verified.status, 'verified');

const rolledBack = await netFlagAction(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');

const mismatch = await netFlagAction(eda, {
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

await assert.rejects(
  () => netFlagAction(eda, { mode: 'apply', items: [] }),
  (error) => error.code === 'INVALID_APPLY_REQUEST',
);

await checkCreateRecovery({
  action: netFlagAction, createEda: createMockEda, namespace: 'sch_PrimitiveComponent', createMethod: 'createNetFlag',
  seed: mock => mock.sch_PrimitiveComponent.createNetFlag('Power', 'OTHER', 0, 0, 0, false),
  applyRequest: async mock => (await netFlagAction(mock, { mode: 'plan', expectedDocumentUuid: 'doc-flags', items: [
    { kind: 'netFlag', identification: 'Ground', net: 'GND', x: 100, y: 200 },
    { kind: 'netFlag', identification: 'Power', net: 'VCC', x: 300, y: 200 },
  ] })).applyRequest,
});

process.stdout.write('schematic-net-flag tests passed\n');
