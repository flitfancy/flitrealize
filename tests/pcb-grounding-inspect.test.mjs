import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const executeAction = await loadAction('pcb-grounding-inspect', 'easyeda-pro');

function sourceRecord(type, id, data) {
  return `${JSON.stringify({ type, id })}||${JSON.stringify(data)}|\n`;
}

function polygon(source) {
  return {
    getSource() {
      return structuredClone(source);
    },
  };
}

function via(id, net, x, y) {
  return {
    getState_PrimitiveId: () => id,
    getState_Net: () => net,
    getState_X: () => x,
    getState_Y: () => y,
    getState_HoleDiameter: () => 12,
    getState_Diameter: () => 24,
    getState_ViaType: () => 'through',
    getState_PrimitiveLock: () => false,
  };
}

const displayOnlySource = sourceRecord('PRIMITIVE', '["PRIMITIVE","PROHIBITEDREGION"]', { display: true, pick: true });
const footprintKeepoutSource = sourceRecord('REGION', 'footprint-region-1', { ruleType: [5], polygon: ['R', 0, 0, 50, 50, 0, 0] });

const eda = {
  dmt_SelectControl: {
    async getCurrentDocumentInfo() {
      return { uuid: 'pcb-ground-test', tabId: 'pcb-ground-test@project-test', documentType: 3, parentProjectUuid: 'project-test' };
    },
  },
  dmt_Project: {
    async getCurrentProjectInfo() {
      return { uuid: 'project-test', name: 'test/project', friendlyName: 'Ground Test' };
    },
  },
  pcb_PrimitivePour: {
    async getAll() {
      return [{
        getState_PrimitiveId: () => 'pour-1',
        getState_Net: () => 'GND',
        getState_Layer: () => 1,
        getState_PourName: () => 'Top GND',
        getState_PourFillMethod: () => 'solid',
        getState_PreserveSilos: () => false,
        getState_PourPriority: () => 5,
        getState_LineWidth: () => 10,
        getState_ComplexPolygon: () => polygon(['R', 0, 0, 1000, 1000, 0, 0]),
      }];
    },
  },
  pcb_PrimitiveRegion: {
    async getAll() {
      return [{
        getState_PrimitiveId: () => 'region-1',
        getState_Layer: () => 1,
        getState_RegionName: () => 'Antenna keepout',
        getState_RuleType: () => [5, 7],
        getState_LineWidth: () => 10,
        getState_ComplexPolygon: () => polygon(['R', 100, 100, 200, 200, 0, 0]),
      }];
    },
  },
  pcb_PrimitiveVia: {
    async getAll() {
      return [via('via-gnd', 'GND', 50, 50), via('via-signal', 'USB_D+', 400, 400)];
    },
  },
  pcb_PrimitiveComponent: {
    async getAll() {
      return [{
        getState_PrimitiveId: () => 'component-u1',
        getState_Designator: () => 'U1',
        getState_Name: () => 'RF module',
        getState_Footprint: () => ({ uuid: 'footprint-rf', libraryUuid: 'library-test', name: 'RF' }),
        getState_Layer: () => 1,
        getState_X: () => 100,
        getState_Y: () => 120,
        getState_Rotation: () => 0,
        getState_Pads: () => [
          { primitiveId: 'pad-1', padNumber: '1', net: 'GND' },
          { primitiveId: 'pad-2', padNumber: '2', net: '3V3' },
        ],
      }];
    },
  },
  sys_FileManager: {
    async getDocumentSource() {
      return displayOnlySource;
    },
    async getDocumentFootprintSources() {
      return [{ footprintUuid: 'footprint-rf', documentSource: footprintKeepoutSource }];
    },
  },
};

const inspected = await executeAction(eda, {
  expectedDocumentUuid: 'pcb-ground-test',
  groundNets: ['GND'],
  criticalDesignators: ['U1'],
  detailLevel: 'full',
});

assert.equal(inspected.status, 'inspected');
assert.equal(inspected.readOnly, true);
assert.equal(inspected.detailLevel, 'full');
assert.equal(inspected.coverage.complete, true);
assert.equal(inspected.pours.count, 1);
assert.deepEqual(inspected.pours.byNet, [{ net: 'GND', count: 1, layers: [1] }]);
assert.equal(inspected.keepouts.viaBlockingApiRegionCount, 1);
assert.equal(inspected.keepouts.documentSource.actualKeepoutRecords.length, 0);
assert.equal(inspected.keepouts.documentSource.displayConfigurationCount, 1);
assert.equal(inspected.keepouts.footprintSources[0].actualKeepoutRecords.length, 1);
assert.equal(inspected.keepouts.componentsWithFootprintKeepouts[0].designator, 'U1');
assert.equal(inspected.keepouts.unresolvedGeometry, true);
assert.equal(inspected.grounding.groundViaCount, 1);
assert.equal(inspected.grounding.componentGrounding[0].groundPadCount, 1);
assert.equal(typeof inspected.inspectionFingerprint, 'string');

process.stdout.write('pcb-grounding-inspect tests passed\n');
