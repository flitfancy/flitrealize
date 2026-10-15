import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAction } from '../helpers/action-harness.mjs';

const executeAction = await loadAction('pcb-board-outline', 'easyeda-pro');

function createMockEda({ existing = [], transformSource = source => source } = {}) {
  const outlines = existing.map((item) => ({ ...item }));
  const created = [];
  const target = {
    uuid: 'pcb-outline-test',
    documentType: 3,
    parentProjectUuid: 'project-outline-test',
  };
  return {
    outlines,
    created,
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { ...target, tabId: `${target.uuid}@${target.parentProjectUuid}` };
      },
    },
    dmt_Project: {
      async getCurrentProjectInfo() {
        return { uuid: target.parentProjectUuid, name: 'test/outline', friendlyName: 'Outline Test' };
      },
    },
    pcb_PrimitivePolyline: {
      async getAll(net, layer) {
        return outlines.filter((item) => (net === undefined || item.net === net)
          && (layer === undefined || item.layer === layer)).map((item) => item.object);
      },
      async create(net, layer, polygon, width, locked) {
        const source = transformSource([...polygon.getSource()]);
        const primitiveId = `outline-${created.length + 1}`;
        const record = { primitiveId, layer, width, source, net, locked };
        const object = {
          getState_PrimitiveId: () => primitiveId,
          getState_Layer: () => record.layer,
          getState_LineWidth: () => record.width,
          getState_Polygon: () => ({ getSource: () => [...record.source] }),
        };
        record.object = object;
        outlines.push(record);
        created.push(record);
        return object;
      },
      async delete(objectOrRecord) {
        const id = typeof objectOrRecord?.getState_PrimitiveId === 'function'
          ? objectOrRecord.getState_PrimitiveId()
          : objectOrRecord?.primitiveId;
        const index = outlines.findIndex((item) => item.primitiveId === id || item.object === objectOrRecord);
        if (index < 0) return false;
        outlines.splice(index, 1);
        return true;
      },
    },
    pcb_MathPolygon: {
      createPolygon(source) {
        return { getSource: () => source };
      },
    },
    pcb_Document: {
      async save() {
        return true;
      },
    },
  };
}

const target = {
  expectedProjectUuid: 'project-outline-test',
  expectedDocumentUuid: 'pcb-outline-test',
};

const empty = createMockEda();
const inspected = await executeAction(empty, { mode: 'inspect', ...target });
assert.equal(inspected.status, 'inspected');
assert.equal(inspected.count, 0);

const planned = await executeAction(empty, {
  mode: 'plan',
  ...target,
  rect: { originX: 0, originY: 0, widthMil: 1000, heightMil: 500 },
  lineWidthMil: 10,
});
assert.equal(planned.status, 'planned');
assert.equal(planned.applyRequest.mode, 'apply');
assert.deepEqual(planned.plan.path, [0, 0, 'L', 1000, 0, 1000, 500, 0, 500, 0, 0]);

const applied = await executeAction(empty, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.outline.layer, 11);
assert.equal(applied.outline.lineWidthMil, 10);
assert.deepEqual(applied.outline.source, [0, 0, 'L', 1000, 0, 1000, 500, 0, 500, 0, 0]);

const verified = await executeAction(empty, { mode: 'verify', ...target });
assert.equal(verified.status, 'verified');

const saved = await executeAction(empty, { mode: 'save', ...target });
assert.equal(saved.status, 'applied');
assert.equal(saved.saved, true);

const occupied = createMockEda({
  existing: [{
    primitiveId: 'old-outline',
    layer: 11,
    lineWidthMil: 10,
    source: [0, 0, 'L', 10, 0, 10, 10, 0, 10, 0, 0],
    object: {
      getState_PrimitiveId: () => 'old-outline',
      getState_Layer: () => 11,
      getState_LineWidth: () => 10,
      getState_Polygon: () => ({ getSource: () => [0, 0, 'L', 10, 0, 10, 10, 0, 10, 0, 0] }),
    },
  }],
});
await assert.rejects(
  async () => executeAction(occupied, {
    mode: 'plan',
    ...target,
    rect: { originX: 0, originY: 0, widthMil: 1000, heightMil: 500 },
  }),
  (error) => error?.code === 'OUTLINE_ALREADY_EXISTS',
);

const replaced = await executeAction(occupied, {
  mode: 'apply',
  ...target,
  replace: true,
  rect: { originX: 0, originY: 0, widthMil: 2000, heightMil: 800 },
  lineWidthMil: 10,
});
assert.equal(replaced.status, 'applied');
assert.deepEqual(replaced.removedIds, ['old-outline']);
assert.equal(replaced.outline.lineWidthMil, 10);

const failedCreate=createMockEda();
failedCreate.pcb_PrimitivePolyline.create=async()=>{throw Error('Fixture create failure');};
const failed=await executeAction(failedCreate,planned.applyRequest);
assert.equal(failed.status,'apply-failed');
assert.equal(failedCreate.outlines.length,0);
assert.notEqual(failed.saved,true);
const failedSave=createMockEda();await executeAction(failedSave,planned.applyRequest);
failedSave.pcb_Document.save=async()=>false;
await assert.rejects(executeAction(failedSave,{mode:'save',...target}));
assert.equal(failedSave.outlines.length,1);

// Replacement failure reports the deleted old outline; it must not pretend rollback.
const failedReplace=createMockEda();await executeAction(failedReplace,planned.applyRequest);
const previousId=failedReplace.outlines[0].primitiveId;
failedReplace.pcb_PrimitivePolyline.create=async()=>{throw Error('Fixture replacement failure');};
const replacementFailure=await executeAction(failedReplace,{mode:'apply',...target,replace:true,rect:{originX:0,originY:0,widthMil:100,heightMil:100}});
assert.equal(replacementFailure.status,'apply-failed');
assert.deepEqual(replacementFailure.removedIds,[previousId]);
assert.equal(replacementFailure.createdRolledBack,false);
assert.equal(replacementFailure.saved,false);
assert.equal(failedReplace.outlines.length,0);

test('rectangle dimensions and closure are preserved at a nonzero signed origin', async () => {
  const eda = createMockEda();
  const result = await executeAction(eda, { mode: 'apply', ...target,
    rect: { originX: -125, originY: 75, widthMil: 1000, heightMil: 350 }, lineWidthMil: 6 });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.outline.source, [-125, 75, 'L', 875, 75, 875, 425, -125, 425, -125, 75]);
  assert.equal((await executeAction(eda, result.verifyRequest)).status, 'verified');
  assert.equal((await executeAction(eda, result.saveRequest)).saved, true);
});

test('changed native vertex or width cannot pass apply readback', async () => {
  for (const fault of ['vertex', 'width']) {
    const eda = createMockEda({ transformSource: source => {
      if (fault === 'vertex') source[3] = 100;
      return source;
    } });
    if (fault === 'width') {
      const create = eda.pcb_PrimitivePolyline.create;
      eda.pcb_PrimitivePolyline.create = async (...args) => { args[3] *= 0.1; return create(...args); };
    }
    const result = await executeAction(eda, planned.applyRequest);
    assert.equal(result.status, 'apply-failed', fault);
    assert.equal(result.error.code, 'OUTLINE_READBACK_FAILED');
    assert.equal(result.createdRolledBack, true);
    assert.equal(eda.outlines.length, 0);
  }
});

test('generated verify and save requests detect edits after apply without saving', async () => {
  for (const fault of ['vertex', 'width']) {
    const eda = createMockEda(), result = await executeAction(eda, planned.applyRequest);
    if (fault === 'vertex') eda.outlines[0].source[3] = 100;
    else eda.outlines[0].width = 1;
    const verified = await executeAction(eda, result.verifyRequest);
    assert.equal(verified.status, 'mismatch');
    assert.ok(verified.issues.some(issue => issue.code === (fault === 'vertex' ? 'OUTLINE_GEOMETRY_MISMATCH' : 'OUTLINE_LINE_WIDTH_MISMATCH')));
    let saves = 0;
    eda.pcb_Document.save = async () => { saves++; return true; };
    await assert.rejects(executeAction(eda, result.saveRequest), { code: 'STALE_SAVE' });
    assert.equal(saves, 0);
  }
});

test('a geometry change during confirmed save is reported by post-save readback', async () => {
  const eda = createMockEda(), result = await executeAction(eda, planned.applyRequest);
  eda.pcb_Document.save = async () => { eda.outlines[0].source[3] = 100; return true; };
  await assert.rejects(executeAction(eda, result.saveRequest), { code: 'SAVE_READBACK_CHANGED' });
});

test('native rectangle serialization may round coordinates and reverse its traversal', async () => {
  const eda=createMockEda({transformSource: source => {
    const n=source.filter(v=>v!=='L').map(v=>Math.round(v*1e4)/1e4),points=[];
    for(let i=0;i<n.length-2;i+=2)points.push([n[i],n[i+1]]);
    points.reverse();const shifted=[...points.slice(1),points[0]];
    return [...shifted[0],'L',...shifted.slice(1).flat(),...shifted[0]];
  }});
  const result=await executeAction(eda,{mode:'apply',...target,rect:{originX:0,originY:0,widthMil:25/.0254,heightMil:22/.0254},lineWidthMil:5});
  assert.equal(result.status,'applied');assert.equal((await executeAction(eda,result.verifyRequest)).status,'verified');
  assert.equal((await executeAction(eda,result.saveRequest)).saved,true);
  eda.outlines[0].source[0]+=.001;
  assert.equal((await executeAction(eda,result.verifyRequest)).status,'mismatch');
});

process.stdout.write('pcb-board-outline tests passed\n');
