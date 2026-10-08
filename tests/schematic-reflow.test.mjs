import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAction } from './helpers/action-harness.mjs';
import { fixture, rec, encode } from './helpers/schematic-reflow-fixture.mjs';

const action = await loadAction('schematic-reflow', 'easyeda-pro');
const input = {
  expectedProjectUuid: 'project', expectedDocumentUuid: 'sheet', phase: 'initial',
  blocks: [{ name: 'main', members: ['A1', 'B1'], columns: 1 }],
  layout: { unit: 'easyeda-schematic', originX: 200, originY: 200,
    componentSpacing: 72, blockSpacing: 210, attachmentSpacing: 140, mainFlow: ['main'] },
};
const complete = { ...input, phase: 'complete' };
const apply = async (f, request) => action(f.eda, (await action(f.eda, request)).applyRequest);
const objectIds = f => f.all().filter(r => ['COMPONENT', 'WIRE'].includes(r.head.type))
  .map(r => r.head.type + ':' + r.head.id).sort();
const networks = f => {
  const markers = new Set(f.all().filter(r => ['netflag', 'netport'].includes(r.payload.componentType)).map(r => r.head.id));
  return f.all().filter(r => r.head.type === 'ATTR'
    && (r.payload.key === 'NET' || markers.has(r.payload.parentId) && r.payload.key === 'Name'))
    .map(r => [r.head.id, r.payload.value]).sort(([a], [b]) => a.localeCompare(b));
};
const separated = (a, b) => a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY;

async function checkGrid(f, step = 5) {
  const onGrid = value => Math.abs(value / step - Math.round(value / step)) < 1e-6;
  for (const c of await f.eda.sch_PrimitiveComponent.getAll()) {
    if (!c.getState_Designator()) continue;
    for (const pin of await c.getAllPins()) {
      assert.ok(onGrid(pin.x) && onGrid(pin.y), pin.getState_PrimitiveId() + ' must remain on the electrical grid');
    }
  }
  for (const r of f.all().filter(r => r.head.type === 'LINE')) {
    assert.ok(['startX', 'startY', 'endX', 'endY'].every(key => onGrid(r.payload[key])), r.head.id);
  }
}

async function checkText(f) {
  const parts = (await f.eda.sch_PrimitiveComponent.getAll()).filter(c => c.getState_Designator());
  const bodies = await Promise.all(parts.map(c => f.eda.sch_Primitive.getPrimitivesBBox([c.getState_PrimitiveId()])));
  for (const r of f.all().filter(r => r.head.type === 'ATTR' && r.payload.valueVisible === true
    && ['Name', 'Designator', 'NET'].includes(r.payload.key))) {
    const box = await f.eda.sch_Primitive.getPrimitivesBBox([r.head.id]);
    assert.ok(bodies.every(body => separated(body, box)), r.head.id + ' must not cover a component body');
  }
}

async function blockBounds(f, members) {
  const owned = id => members.some(ref => id === ref || id.startsWith(ref + '-w') || id.startsWith(ref + '-f'));
  const ids = f.all().filter(r => r.head.type === 'COMPONENT' && owned(r.head.id)
    || r.head.type === 'ATTR' && owned(r.payload.parentId) && r.payload.valueVisible !== false)
    .map(r => r.head.id);
  return f.eda.sch_Primitive.getPrimitivesBBox(ids);
}

test('initial planning is read-only and applying places native bodies on the electrical grid', async () => {
  const f = fixture(), original = f.source;
  const plan = await action(f.eda, input);
  assert.equal(plan.status, 'planned');
  assert.equal(f.writes, 0); assert.equal(f.source, original); assert.equal(plan.backupSource, original);
  assert.equal(plan.componentCount, 2); assert.equal(plan.movedCount, 2);
  await action(f.eda, plan.applyRequest);
  assert.equal(f.writes, 1); assert.equal(f.saves, 1); assert.ok(!f.source.endsWith('|'));
  assert.equal((await action(f.eda, { ...input, mode: 'verify' })).status, 'verified');
  const [a, b] = await Promise.all(['A1', 'B1'].map(id => f.eda.sch_Primitive.getPrimitivesBBox([id])));
  assert.equal(f.component('A1').x, f.component('B1').x);
  assert.ok(Math.abs(f.component('A1').y - f.component('B1').y) >= input.layout.componentSpacing);
  assert.ok(separated(a, b));
  await checkGrid(f);
});

test('complete reflow preserves signal objects, networks and notes and converges without another import', async () => {
  const f = fixture(); await f.connect();
  const ids = objectIds(f), nets = networks(f), note = f.all().find(r => r.head.id === 'unrelated-note');
  await assert.rejects(() => action(f.eda, input), /unconnected sheet/);
  await apply(f, complete);
  assert.equal((await action(f.eda, { ...complete, mode: 'verify' })).status, 'verified');
  assert.deepEqual(objectIds(f), ids); assert.deepEqual(networks(f), nets);
  assert.deepEqual(f.all().find(r => r.head.id === 'unrelated-note'), note);
  const attributes = f.all().filter(r => r.head.type === 'ATTR');
  assert.ok(attributes.filter(r => r.payload.parentId.includes('-f')).every(r => r.payload.valueVisible === false));
  assert.ok(attributes.filter(r => r.payload.key === 'NET').every(r => r.payload.valueVisible === true && r.payload.rotation === 0),
    'netflag network labels remain horizontal even on vertical stubs');
  assert.ok(attributes.filter(r => ['A1', 'B1'].includes(r.payload.parentId)).every(r => r.payload.valueVisible === true));
  await f.checkConnections(); await checkGrid(f); await checkText(f);
  const writes = f.writes;
  await apply(f, complete);
  assert.equal(f.writes, writes, 'a converged rerun must not import source again');
});

test('net ports face their wire direction and keep hidden names while vertical NET text rotates', async () => {
  const f = fixture(); await f.connect();
  f.source = encode(f.all().map(r => {
    if (['A1-f0', 'B1-f0'].includes(r.head.id)) r.payload.componentType = 'netport';
    return r;
  }));
  await apply(f, complete);
  for (const [id, rotation] of [['A1-f0', 180], ['B1-f0', 270]]) {
    assert.equal(f.all().find(r => r.head.id === id).payload.rotation, rotation);
    assert.equal(f.all().find(r => r.head.id === id + '-name').payload.valueVisible, false);
  }
  assert.equal(f.all().find(r => r.head.id === 'B1-w0-net').payload.rotation, 90);
  assert.equal(f.all().find(r => r.head.id === 'B1-w1-net').payload.rotation, 0);
  await f.checkConnections();
  assert.equal((await action(f.eda, { ...complete, mode: 'verify' })).status, 'verified');
});

test('source edits, changed plans and wrong targets stop before mutation', async () => {
  const f = fixture(); await f.connect();
  const plan = await action(f.eda, complete);
  f.source = f.source.replace('LONG_COMPONENT_VALUE', 'USER_EDIT');
  await assert.rejects(() => action(f.eda, plan.applyRequest), /Stale reflow/);
  await assert.rejects(() => action(f.eda, { ...input, expectedDocumentUuid: 'other' }), /Unexpected schematic/);
  await assert.rejects(() => action(f.eda, { ...complete, blocks: [{ name: 'main', members: ['A1', 'A1'], columns: 1 }] }), /exactly once/);
  await assert.rejects(() => action(f.eda, { ...complete, layout: { ...input.layout, unit: 'unknown' } }), /layout.unit/);
  const current = await action(f.eda, complete);
  await assert.rejects(() => action(f.eda, { ...current.applyRequest, layout: { ...input.layout, componentSpacing: 73 } }), /Stale reflow/);
  assert.equal(f.writes, 0);
});

test('rejected imports and failed saves keep the actual mutation outcome without replay', async () => {
  const rejected = fixture(), original = rejected.source, plan = await action(rejected.eda, input);
  rejected.reject();
  await assert.rejects(() => action(rejected.eda, plan.applyRequest), /import rejected/);
  assert.equal(rejected.source, original); assert.equal(rejected.saves, 0); assert.equal(rejected.writes, 1);
  const unsaved = fixture(), savePlan = await action(unsaved.eda, input);
  unsaved.eda.sch_Document.save = async () => false;
  await assert.rejects(() => action(unsaved.eda, savePlan.applyRequest), /save.*failed/i);
  assert.equal(unsaved.writes, 1, 'a failed save must not trigger another import or rollback');
});

test('malformed source, invalid component geometry and invalid native wire coordinates are rejected', async () => {
  const malformed = fixture();
  malformed.eda.sys_FileManager.getDocumentSource = async () => malformed.source.replace('"grid":5', '"grid":broken');
  await assert.rejects(() => action(malformed.eda, input), /Invalid source record/);
  assert.equal(malformed.writes, 0);
  const invalid = fixture(); invalid.source = invalid.source.replace('"x":10', '"x":null');
  await assert.rejects(() => action(invalid.eda, input), /Invalid component\/pin geometry/);
  assert.equal(invalid.writes, 0);
  const wire = fixture(); await wire.connect();
  wire.source = wire.source.replace(/"startX":-?\d+/, '"startX":null');
  await assert.rejects(() => action(wire.eda, complete), /Invalid native wire coordinates/);
  assert.equal(wire.writes, 0);
  const broken = fixture(); await broken.connect();
  broken.source = broken.source.replace('"startX":', '"startX":99999,"ignoredX":');
  await assert.rejects(() => action(broken.eda, complete), /wire owner|orthogonal wire/);
  assert.equal(broken.writes, 0);
});

test('missing native bounds, pin identity and incompatible pin pitch never become a guessed layout', async () => {
  const noApi = fixture(); delete noApi.eda.sch_Primitive;
  await assert.rejects(() => action(noApi.eda, input), /Native primitive bounds API required/);
  assert.equal(noApi.writes, 0);
  const noBounds = fixture(); noBounds.eda.sch_Primitive.getPrimitivesBBox = async () => undefined;
  await assert.rejects(() => action(noBounds.eda, input), /Native bounds unavailable/);
  assert.equal(noBounds.writes, 0);
  for (const [fault, expected] of [
    [pin => { delete pin.getState_PrimitiveId; }, /Native pin identity unavailable/],
    [pin => { pin.x += 1; }, /GRID_INCOMPATIBLE_PIN/],
  ]) {
    const f = fixture(), read = f.eda.sch_PrimitiveComponent.getAll;
    f.eda.sch_PrimitiveComponent.getAll = async () => (await read()).map(c => {
      if (c.getState_Designator() !== 'A1') return c;
      const pins = c.getAllPins.bind(c);
      c.getAllPins = async () => { const result = await pins(); fault(result[1]); return result; };
      return c;
    });
    await assert.rejects(() => action(f.eda, input), expected);
    assert.equal(f.writes, 0);
  }
});

test('mil and schematic-unit requests produce the same physical plan', async () => {
  const f = fixture();
  const mil = { ...input, layout: { ...input.layout, unit: 'mil', originX: 2000, originY: 2000,
    componentSpacing: 720, blockSpacing: 2100, attachmentSpacing: 1400 } };
  assert.deepEqual((await action(f.eda, mil)).deltas, (await action(f.eda, input)).deltas);
});

for (const [index, side] of ['top', 'bottom', 'left', 'right'].entries()) {
  test('attachment ' + side + ' preserves connections, grid and block clearance across project sizes', async () => {
    const f = fixture(5 + index * 4); await f.connect();
    const ids = (await f.eda.sch_PrimitiveComponent.getAll()).filter(c => c.getState_Designator()).map(c => c.getState_Designator());
    const main = ids.slice(0, -2), aux = ids.slice(-2);
    const config = { ...complete, blocks: [{ name: 'flow', members: main, columns: index + 1 }, { name: 'aux', members: aux, columns: 2 }],
      layout: { ...input.layout, originX: -100, originY: -200, mainFlow: ['flow'],
        attachments: [{ block: 'aux', targets: ['flow'], preferredSide: side }] } };
    const originalNetworks = networks(f);
    await apply(f, config); await f.checkConnections(); await checkGrid(f); await checkText(f);
    assert.deepEqual(networks(f), originalNetworks);
    const a = await blockBounds(f, main), b = await blockBounds(f, aux);
    const gap = side === 'top' ? b.minY - a.maxY : side === 'bottom' ? a.minY - b.maxY
      : side === 'left' ? a.minX - b.maxX : b.minX - a.maxX;
    assert.ok(gap >= config.layout.attachmentSpacing - 1e-6, side + ' must preserve the requested gap: ' + gap);
    assert.equal((await action(f.eda, { ...config, mode: 'verify' })).status, 'verified');
    const writes = f.writes; await apply(f, config);
    assert.equal(f.writes, writes);
  });
}

test('one invocation reads components, pins and wires once for a consistent snapshot', async () => {
  const f = fixture(); await f.connect();
  let componentReads = 0, wireReads = 0, pinReads = 0, lineReads = 0;
  const components = f.eda.sch_PrimitiveComponent.getAll, wires = f.eda.sch_PrimitiveWire.getAll;
  f.eda.sch_PrimitiveComponent.getAll = async () => {
    componentReads++;
    return (await components()).map(c => {
      const pins = c.getAllPins.bind(c);
      c.getAllPins = async () => { pinReads++; return pins(); };
      return c;
    });
  };
  f.eda.sch_PrimitiveWire.getAll = async () => {
    wireReads++;
    return (await wires()).map(w => {
      const line = w.getState_Line;
      w.getState_Line = () => { lineReads++; return line(); };
      return w;
    });
  };
  await action(f.eda, complete);
  assert.deepEqual({ componentReads, wireReads, pinReads, lineReads }, { componentReads: 1, wireReads: 1, pinReads: 2, lineReads: 4 });
});

test('native body margins and mixed-width text with explicit fonts converge without overlaps', async () => {
  const f = fixture(), padded = { ...input, text: { bodyMargin: 40 } };
  await apply(f, padded);
  const body = await f.eda.sch_Primitive.getPrimitivesBBox(['A1']);
  assert.ok(body.minX - input.layout.originX >= 40, 'padding uses native body bounds and permits grid rounding');
  await f.connect();
  f.source = f.source.replace('LONG_COMPONENT_VALUE', '长文字_' + 'ABC_'.repeat(24));
  const configured = { ...padded, phase: 'complete', text: { bodyMargin: 40, nameFontSize: 12, netFontSize: 11 } };
  await apply(f, configured); await f.checkConnections(); await checkGrid(f); await checkText(f);
  assert.equal(f.all().find(r => r.head.id === 'A1-Name').payload.fontSize, 12);
  assert.ok(f.all().filter(r => r.payload.key === 'NET').every(r => r.payload.fontSize === 11));
  assert.equal((await action(f.eda, { ...configured, mode: 'verify' })).status, 'verified');
});

test('unknown source font sizes are preserved and cannot justify explicit font rescaling', async () => {
  const f = fixture(); await f.connect();
  f.source = encode(f.all().map(r => { if (r.head.type === 'ATTR') r.payload.fontSize = null; return r; }));
  await assert.rejects(() => action(f.eda, { ...complete, text: { nameFontSize: 12 } }), /Native text font size unavailable/);
  assert.equal(f.writes, 0);
  await apply(f, complete);
  assert.ok(f.all().filter(r => ['Name', 'NET', 'Designator'].includes(r.payload.key)).every(r => r.payload.fontSize === null));
  assert.equal((await action(f.eda, { ...complete, mode: 'verify' })).status, 'verified');
});

test('fractional source anchors are moved together onto the grid without separating wires from pins', async () => {
  const f = fixture(); await f.connect();
  f.source = encode(f.all().map(r => {
    if (r.head.type === 'COMPONENT') { r.payload.x += .125; r.payload.y -= .375; }
    if (r.head.type === 'LINE') {
      r.payload.startX += .125; r.payload.endX += .125; r.payload.startY -= .375; r.payload.endY -= .375;
    }
    return r;
  }));
  await apply(f, complete); await f.checkConnections(); await checkGrid(f);
  assert.equal((await action(f.eda, { ...complete, mode: 'verify' })).status, 'verified');
});

test('duplicate attributes and coincident markers remain blocking instead of selecting a winner', async () => {
  const attr = fixture();
  attr.source = encode([...attr.all(), rec('ATTR', 'extra-name', {
    parentId: 'A1', key: 'Name', value: 'duplicate', valueVisible: true, x: 10, y: -10,
  })]);
  await assert.rejects(() => action(attr.eda, complete), /Expected one Name attribute/);
  assert.equal(attr.writes, 0);
  const flag = fixture(); await flag.connect();
  const original = flag.all().find(r => r.head.id === 'A1-f0');
  flag.source = encode([...flag.all(), rec('COMPONENT', 'extra-flag', { ...original.payload }),
    rec('ATTR', 'extra-flag-name', { parentId: 'extra-flag', key: 'Name', value: 'NET_A1_0' })]);
  await assert.rejects(() => action(flag.eda, complete), /Ambiguous flag/);
  assert.equal(flag.writes, 0);
});

test('native text measurement resolves attribute expressions without losing a zero Value', async () => {
  const expression = fixture(), literal = fixture();
  expression.source = encode([...expression.all().map(r => {
    if (r.head.id === 'A1-Name') r.payload.value = '={Value}';
    return r;
  }), rec('ATTR', 'value-zero', { parentId: 'A1', key: 'Value', value: 0, valueVisible: false })]);
  literal.source = literal.source.replace('LONG_COMPONENT_VALUE', '0');
  assert.deepEqual((await action(expression.eda, complete)).deltas, (await action(literal.eda, complete)).deltas);
});

test('native pin-owned NC markers move with the pin and are restored if source import drops their state', async () => {
  const f = fixture(2, { dropNoConnectOnImport: true });
  await f.setNoConnect('A1', 2); await f.connect();
  const plan = await action(f.eda, complete);
  assert.equal(f.pinWrites, 0); assert.equal(f.writes, 0);
  const applied = await action(f.eda, plan.applyRequest);
  assert.deepEqual(applied.noConnectRestore, { expected: 1, restored: 1 });
  assert.deepEqual(applied.noConnectGeometry, { checked: 1, passed: true });
  assert.equal(f.pinWrites, 1);
  const pin = (await f.component('A1').getAllPins())[1];
  const marker = f.all().find(r => r.payload.key === 'NO_CONNECT');
  assert.equal(pin.getState_NoConnected(), true);
  assert.equal(marker.payload.parentId, pin.getState_PrimitiveId());
  assert.equal(marker.payload.x, pin.x); assert.equal(marker.payload.y, -pin.y);
  await f.checkConnections(); await checkGrid(f);
  assert.equal((await action(f.eda, { ...complete, mode: 'verify' })).status, 'verified');
});

test('identical intent stays deterministic when native enumeration and member ordering change', async () => {
  const a = fixture(5), b = fixture(5);
  await a.connect(); await b.connect();
  const members = ['A1', 'B1', 'X2', 'X3', 'X4'];
  const config = { ...complete, blocks: [{ name: 'main', members, columns: 2 }] };
  const read = b.eda.sch_PrimitiveComponent.getAll;
  b.eda.sch_PrimitiveComponent.getAll = async () => (await read()).reverse();
  const original = await action(a.eda, config);
  const reordered = await action(b.eda, { ...config, blocks: [{ ...config.blocks[0], members: members.toReversed() }] });
  assert.deepEqual(original.deltas.toSorted(([x], [y]) => x.localeCompare(y)),
    reordered.deltas.toSorted(([x], [y]) => x.localeCompare(y)));
  assert.equal(a.writes, 0); assert.equal(b.writes, 0);
});
