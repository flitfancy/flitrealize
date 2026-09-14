import { loadAction } from './action-harness.mjs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wrap = states => Object.fromEntries(Object.entries(states).map(([key, value]) => ['getState_' + key, () => value]));
const line = (type, id, payload) => `${JSON.stringify({ type, id })}||${JSON.stringify(payload)}|`;

/** Stateful provider fixture; only reflow is stubbed, because these tests exercise orchestration. */
export function mockConnections(count = 2, withNc = true) {
  const eda = { calls: [], wires: [], markers: [], wireCreates: 0, markerCreates: 0, ncWrites: 0,
    saveCount: 0, drcCount: 0, reflowCount: 0, drcResult: true, saveResult: true,
    document: { uuid: 'sch-connect', parentProjectUuid: 'project-connect', documentType: 1 } };
  eda.parts = Array.from({ length: count }, (_, index) => ({ id: `part-${index + 1}`, designator: `U${index + 1}`,
    x: index * 200, y: 100, value: 'SENSOR-1', pins: [
      { number: '1', name: 'SIGNAL', x: index * 200 + 20, y: 100, noConnected: false },
      ...(withNc ? [{ number: '2', name: 'NC', x: index * 200 + 20, y: 140, noConnected: false }] : []),
    ] }));
  const pinObject = (part, pin) => ({ ...wrap({ PrimitiveId: `${part.id}:${pin.number}`, PinNumber: pin.number,
    PinName: pin.name, X: pin.x, Y: pin.y, Rotation: 0, NoConnected: pin.noConnected }), _row: pin });
  const partObject = row => wrap({ PrimitiveId: row.id, Designator: row.designator, ComponentType: 'part',
    X: row.x, Y: row.y, Rotation: 0, Mirror: false, OtherProperty: { Value: row.value }, AddIntoBom: true, AddIntoPcb: true,
    Component: { libraryUuid: 'fixture-library', uuid: 'fixture-device' } });
  const markerObject = row => wrap({ PrimitiveId: row.id, Designator: '', ComponentType: row.type, Net: row.net,
    X: row.x, Y: row.y, Rotation: row.rotation, Mirror: row.mirror });
  const wireObject = row => wrap({ PrimitiveId: row.id, Net: row.net, Line: row.points, Color: row.color,
    LineWidth: row.lineWidth, LineType: row.lineType });
  eda.source = () => [line('DOCHEAD', 'head', { title: 'Fixture' }),
    ...eda.parts.flatMap(part => [line('COMPONENT', part.id, { x: part.x, y: part.y }),
      ...part.pins.map(pin => line('PIN', `${part.id}:${pin.number}`, { ...pin, parentId: part.id }))]),
    ...eda.wires.flatMap(wire => [line('WIRE', wire.id, { points: wire.points }),
      line('ATTR', `net-${wire.id}`, { parentId: wire.id, key: 'NET', value: wire.net, valueVisible: wire.visible !== false })]),
    ...eda.markers.flatMap(marker => [line('COMPONENT', marker.id, { componentType: marker.type, x: marker.x, y: marker.y }),
      line('ATTR', `name-${marker.id}`, { parentId: marker.id, key: 'Name', value: marker.net, valueVisible: marker.visible !== false })]),
    ...(eda.note ? [line('TEXT', 'note', { text: eda.note })] : []),
  ].join('\n');
  eda.dmt_SelectControl = { async getCurrentDocumentInfo() { return { ...eda.document }; } };
  eda.sys_FileManager = {
    async getDocumentSource() { return eda.source(); },
    async setDocumentSource(source) {
      for (const entry of source.split(/\r?\n/).filter(Boolean)) {
        const split = entry.indexOf('||'), head = JSON.parse(entry.slice(0, split));
        const data = JSON.parse(entry.slice(split + 2).replace(/\|$/, ''));
        if (head.type === 'ATTR') {
          const row = [...eda.wires, ...eda.markers].find(item => item.id === data.parentId);
          if (row) row.visible = data.valueVisible !== false;
        }
      }
      return true;
    },
  };
  const createMarker = (type, net, x, y, rotation, mirror) => {
    const row = { id: `marker-${++eda.markerCreates}`, type, net, x, y, rotation, mirror, visible: true };
    eda.markers.push(row); return markerObject(row);
  };
  eda.sch_PrimitiveComponent = {
    async getAll() { return [...eda.parts.map(partObject), ...eda.markers.map(markerObject)]; },
    async getAllPinsByPrimitiveId(id) {
      const part = eda.parts.find(item => item.id === id);
      return part ? part.pins.map(pin => pinObject(part, pin)) : [];
    },
    async createNetPort(_direction, net, x, y, rotation, mirror) { return createMarker('netport', net, x, y, rotation, mirror); },
    async createNetFlag(_identification, net, x, y, rotation, mirror) { return createMarker('netflag', net, x, y, rotation, mirror); },
    async delete(ids) { eda.markers = eda.markers.filter(marker => !ids.includes(marker.id)); return true; },
  };
  eda.sch_PrimitivePin = { async modify(pin, patch) { eda.ncWrites++; Object.assign(pin._row, patch); return pin; } };
  eda.sch_PrimitiveWire = {
    async getAll() { return eda.wires.map(wireObject); },
    async get(ids) { return Array.isArray(ids) ? eda.wires.filter(wire => ids.includes(wire.id)).map(wireObject)
      : eda.wires.find(wire => wire.id === ids) ? wireObject(eda.wires.find(wire => wire.id === ids)) : null; },
    async create(points, net, color, lineWidth, lineType) {
      const row = { id: `wire-${++eda.wireCreates}`, points, net, color, lineWidth, lineType, visible: true };
      eda.wires.push(row); return wireObject(row);
    },
    async delete(ids) { eda.wires = eda.wires.filter(wire => !ids.includes(wire.id)); return true; },
  };
  eda.sch_Net = { async getAllNetsName() { return [...new Set(eda.wires.map(wire => wire.net))]; } };
  eda.sch_Document = { async save() { eda.saveCount++; eda.afterSave?.(); return eda.saveResult; } };
  eda.sch_Drc = { async check(...args) { eda.drcCount++; eda.drcArgs = args; return eda.drcResult; } };
  return eda;
}

export async function connectFixture(t, { count = 2, withNc = true, reflow = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flitrealize-connect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = JSON.parse(await readFile(new URL('../fixtures/schematic-contract/valid-provider-binding.json', import.meta.url), 'utf8'));
  const template = contract.components[0];
  contract.project.id = 'project-connect';
  contract.components = Array.from({ length: count }, (_, index) => ({ ...structuredClone(template), designator: `U${index + 1}`,
    pinMapCoverage: 'complete', pins: [template.pins[0], ...(withNc ? [{ number: '2', function: 'UNUSED', classification: 'no-connect' }] : [])] }));
  contract.blocks[0].components = contract.components.map(part => part.designator);
  contract.nets[0].endpoints = contract.components.map(part => ({ component: part.designator, pin: '1' }));
  const input = { contractFile: 'contract.json', expectedDocumentUuid: 'sch-connect', expectedProjectUuid: 'project-connect',
    strategy: 'endpoint-stubs', stubLength: 20,
    ...(reflow ? { reflow: { blocks: [{ name: 'Sensors', designators: contract.blocks[0].components }] } } : {}) };
  const inputFile = join(root, 'input.json');
  await writeFile(join(root, 'contract.json'), JSON.stringify(contract));
  await writeFile(inputFile, JSON.stringify(input));
  const eda = mockConnections(count, withNc), actions = new Map();
  const invoke = async (action, request, context) => {
    eda.calls.push({ action, mode: request.mode, mutates: context.mutates });
    let result;
    if (action === 'schematic-reflow') {
      if (request.mode === 'plan') result = { status: 'planned', backupSource: eda.source(), applyRequest: { ...request, mode: 'apply' } };
      else if (request.mode === 'apply') { eda.reflowCount++; result = { status: 'applied', saved: false }; }
      else result = { status: 'verified' };
    } else {
      if (!actions.has(action)) actions.set(action, await loadAction(action, 'easyeda-pro'));
      result = await actions.get(action)(eda, request);
    }
    return { action, mode: request.mode, response: { success: true, result } };
  };
  return { root, inputFile, input, contract, eda, invoke,
    async writeInput() { await writeFile(inputFile, JSON.stringify(input)); },
    async writeContract() { await writeFile(join(root, 'contract.json'), JSON.stringify(contract)); },
  };
}
