import { loadAction } from './action-harness.mjs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function mockComponents() {
  const eda = { records: [], calls: [], createCount: 0, saveCount: 0, drcCount: 0,
    document: { uuid: 'sch-batch', parentProjectUuid: 'project-batch', documentType: 1 }, saveResult: true, directIdentity: true };
  const wrap = row => Object.fromEntries(Object.entries({ PrimitiveId: row.id, Designator: row.designator, X: row.x, Y: row.y, Rotation: row.rotation,
    Mirror: row.mirror, AddIntoBom: row.addIntoBom, AddIntoPcb: row.addIntoPcb, ComponentType: 0,
    OtherProperty: row.otherProperty || {},
    LibraryUuid: eda.directIdentity ? row.libraryUuid : null, Uuid: eda.directIdentity ? row.uuid : null,
    Component: { libraryUuid: row.libraryUuid, uuid: row.uuid },
  }).map(([key, value]) => ['getState_' + key, () => value]));
  eda.dmt_SelectControl = { async getCurrentDocumentInfo() { return { ...eda.document }; } };
  eda.sch_PrimitiveComponent = {
    async getAll() { if (eda.readError) throw new Error('read failure'); return eda.records.map(wrap); },
    async get(id) { return eda.records.find(r => r.id === id) ? wrap(eda.records.find(r => r.id === id)) : null; },
    async create(component, x, y, subPartName, rotation, mirror, addIntoBom, addIntoPcb) {
      eda.createCount++;
      if (eda.failCreateAt === eda.createCount) throw new Error('injected create failure');
      const row = { id: 'id-' + eda.createCount, designator: 'AUTO' + eda.createCount, ...component, x, y, subPartName, rotation, mirror, addIntoBom, addIntoPcb };
      eda.records.push(row);
      eda.afterCreate?.(row);
      return wrap(row);
    },
    async modify(id, patch) {
      if (eda.modifyFailure) return false;
      const row = eda.records.find(item => item.id === id);
      Object.assign(row, patch, patch.otherProperty ? { otherProperty: { ...(row.otherProperty || {}), ...patch.otherProperty } } : {});
      return true;
    },
    async delete(ids) { eda.records = eda.records.filter(row => !ids.includes(row.id)); return true; },
  };
  eda.sch_PrimitiveWire = { async getAll() { return []; } };
  eda.sys_FileManager = { async getDocumentSource() { return JSON.stringify({ doc: eda.document, records: eda.records, note: eda.note || '' }); } };
  eda.sch_Document = { async save() { eda.saveCount++; eda.afterSave?.(); return eda.saveResult; } };
  eda.sch_Drc = { async check() { eda.drcCount++; return false; } };
  return eda;
}

export async function batchFixture(t, count = 5) {
  const root = await mkdtemp(join(tmpdir(), 'flitrealize-components-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = JSON.parse(await readFile(new URL('../fixtures/schematic-contract/valid-provider-binding.json', import.meta.url), 'utf8'));
  const template = contract.components[0];
  contract.components = Array.from({ length: count }, (_, index) => ({ ...structuredClone(template), designator: 'R' + (index + 1), role: 'passive' }));
  const refs = contract.components.map(c => c.designator);
  contract.blocks[0].components = refs;
  contract.nets[0].endpoints = refs.map(component => ({ component, pin: '1' }));
  const input = { contractFile: 'contract.json', expectedProjectUuid: 'project-batch', expectedDocumentUuid: 'sch-batch', designators: refs, batchSize: 3 };
  await writeFile(join(root, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(root, 'input.json'), JSON.stringify(input));
  const eda = mockComponents();
  const actions = new Map();
  const invoke = async (action, request, context) => {
    eda.calls.push({ action, mode: request.mode, mutates: context.mutates });
    if (!actions.has(action)) actions.set(action, await loadAction(action, 'easyeda-pro'));
    return actions.get(action)(eda, request);
  };
  return { root, input, contract, eda, invoke, inputFile: join(root, 'input.json') };
}
