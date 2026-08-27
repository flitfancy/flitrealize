import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const inspectAction = await loadAction('pcb-grounding-inspect');
const stitchingAction = await loadAction('pcb-ground-stitching');
const viaAction = await loadAction('pcb-ground-vias');

function sourceRecord(type, id, data) {
  return `${JSON.stringify({ type, id })}||${JSON.stringify(data)}|\n`;
}

function polygon(source, points) {
  return {
    getSource: () => structuredClone(source),
    async discretize() {
      return structuredClone(points);
    },
  };
}

function viaPrimitive(state) {
  return {
    getState_PrimitiveId: () => state.primitiveId,
    getState_Net: () => state.net,
    getState_X: () => state.x,
    getState_Y: () => state.y,
    getState_HoleDiameter: () => state.holeDiameter,
    getState_Diameter: () => state.diameter,
    getState_ViaType: () => 'through',
    getState_PrimitiveLock: () => false,
  };
}

function createMockEda({ missingLayer16Fill = false, openBoard = false, viasOverride = null } = {}) {
  const vias = viasOverride ?? (openBoard ? [] : [
    { primitiveId: 'gnd-existing', net: 'GND', x: 100, y: 100, holeDiameter: 12, diameter: 24 },
    { primitiveId: 'signal-1', net: 'SIG_A', x: 500, y: 300, holeDiameter: 12, diameter: 24 },
  ]);
  const outlinePolygon = polygon(
    ['R', 0, 600, 1000, 600, 0, 0],
    [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 600 }, { x: 0, y: 600 }],
  );
  const keepoutPolygon = {
    getSource: () => ['CIRCLE', 800, 300, 80],
    async discretize() {
      throw new Error('Not implemented');
    },
  };
  const pad = {
    getState_PrimitiveId: () => 'u1-pad-1',
    getState_ParentComponentPrimitiveId: () => 'component-u1',
    getState_Net: () => '3V3',
    getState_PadNumber: () => '1',
    getState_Layer: () => 1,
    getState_X: () => 300,
    getState_Y: () => 300,
    getState_Pad: () => ['RECTANGLE', 80, 80, 0],
  };
  const component = {
    getState_PrimitiveId: () => 'component-u1',
    getState_Designator: () => 'U1',
    getState_Name: () => 'Mock IC',
    getState_Footprint: () => ({ uuid: 'footprint-test', libraryUuid: 'library-test', name: 'Mock' }),
    getState_Layer: () => 1,
    getState_X: () => 300,
    getState_Y: () => 300,
    getState_Rotation: () => 0,
    getState_Pads: () => [{ primitiveId: 'u1-pad-1', padNumber: '1', net: '3V3' }],
    async getAllPins() {
      return [pad];
    },
  };
  const pours = [15, 16].map((layer) => ({
    getState_PrimitiveId: () => `pour-${layer}`,
    getState_Net: () => 'GND',
    getState_Layer: () => layer,
    getState_PourName: () => `GND L${layer}`,
    getState_PourFillMethod: () => 'solid',
    getState_PreserveSilos: () => false,
    getState_PourPriority: () => 5,
    getState_LineWidth: () => 10,
    getState_ComplexPolygon: () => outlinePolygon,
  }));
  const poured = [15, ...(missingLayer16Fill ? [] : [16])].map((layer) => ({
    getState_PrimitiveId: () => `poured-${layer}`,
    getState_PourPrimitiveId: () => `pour-${layer}`,
    getState_PourFills: () => [{ id: `fill-${layer}` }],
  }));
  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'pcb-stitch-test', tabId: 'pcb-stitch-test@project-test', documentType: 3, parentProjectUuid: 'project-test' };
      },
    },
    dmt_Project: {
      async getCurrentProjectInfo() {
        return { uuid: 'project-test', name: 'test/project', friendlyName: 'Stitching Test' };
      },
    },
    pcb_Layer: {
      async getAllLayers() {
        return [
          { id: 1, name: 'Top', layerStatus: 1 },
          { id: 15, name: 'Inner1', layerStatus: 1 },
          { id: 16, name: 'Inner2', layerStatus: 1 },
          { id: 2, name: 'Bottom', layerStatus: 1 },
        ];
      },
    },
    pcb_PrimitivePolyline: {
      async getAll() {
        return [{
          getState_PrimitiveId: () => 'outline-1',
          getState_Layer: () => 11,
          getState_Polygon: () => outlinePolygon,
        }];
      },
    },
    pcb_PrimitiveRegion: {
      async getAll() {
        return openBoard ? [] : [{
          getState_PrimitiveId: () => 'keepout-1',
          getState_Layer: () => 12,
          getState_RuleType: () => [5, 6, 7, 8],
          getState_ComplexPolygon: () => keepoutPolygon,
        }];
      },
    },
    pcb_PrimitiveVia: {
      async getAll() {
        return vias.map(viaPrimitive);
      },
    },
    pcb_PrimitiveComponent: {
      async getAll() {
        return openBoard ? [] : [component];
      },
    },
    pcb_PrimitivePad: {
      async getAll() {
        return [];
      },
    },
    pcb_PrimitiveLine: {
      async getAll() {
        return openBoard ? [] : [{
          getState_PrimitiveId: () => 'track-1',
          getState_Net: () => 'SIG_B',
          getState_Layer: () => 1,
          getState_LineWidth: () => 20,
          getState_StartX: () => 400,
          getState_StartY: () => 100,
          getState_EndX: () => 400,
          getState_EndY: () => 500,
        }];
      },
    },
    pcb_PrimitiveArc: {
      async getAll() {
        return [];
      },
    },
    pcb_PrimitivePour: {
      async getAll() {
        return pours;
      },
    },
    pcb_PrimitivePoured: {
      async getAll() {
        return poured;
      },
    },
    sys_FileManager: {
      async getDocumentSource() {
        return sourceRecord('PRIMITIVE', '["PRIMITIVE","PROHIBITEDREGION"]', { display: true, pick: true });
      },
      async getDocumentFootprintSources() {
        return [{ footprintUuid: 'footprint-test', documentSource: sourceRecord('PAD', 'pad-1', { x: 0, y: 0 }) }];
      },
    },
  };
}

function generation(inspectionFingerprint) {
  return {
    schemaVersion: 1,
    expectedDocumentUuid: 'pcb-stitch-test',
    expectedInspectionFingerprint: inspectionFingerprint,
    net: 'GND',
    via: { holeDiameter: 12, diameter: 24 },
    requiredGroundLayerIds: [15, 16],
    clearance: 10,
    edgeClearance: 10,
    minimumCenterSpacing: 10,
    maxSelected: 12,
    detailLevel: 'full',
    strategies: [
      { type: 'signal-transition-return', gap: 10, countPerVia: 1, maxCount: 2 },
      { type: 'edge-fence', spacing: 250, inset: 40, minimumGroundViaDistance: 80, maxCount: 4 },
      { type: 'plane-grid', pitch: 200, inset: 100, minimumGroundViaDistance: 100, stagger: true, maxCount: 6 },
    ],
  };
}

const eda = createMockEda();
const inspected = await inspectAction(eda, { expectedDocumentUuid: 'pcb-stitch-test' });
const plannerInspection = await stitchingAction(eda, { mode: 'inspect', expectedDocumentUuid: 'pcb-stitch-test' });
assert.equal(plannerInspection.status, 'inspected');
assert.equal(plannerInspection.readOnly, true);
assert.equal(plannerInspection.state.outline.status, 'resolved');
assert.equal(plannerInspection.state.counts.vias, 2);

const generated = await stitchingAction(eda, { mode: 'generate', generation: generation(inspected.inspectionFingerprint) });
assert.equal(generated.status, 'generated');
assert.equal(generated.readOnly, true);
assert.equal(generated.globalIssues.length, 0);
assert.ok(generated.selected.length > 0);
assert.ok(generated.selected.length <= 12);
assert.equal(generated.plan.expectedInspectionFingerprint, inspected.inspectionFingerprint);
assert.equal(generated.plan.boardContainmentConfirmed, true);
assert.equal(generated.plan.localClearanceConfirmed, true);
assert.equal(generated.plan.vias.some((via) => via.strategy === 'signal-transition-return'), true);
assert.equal(generated.rejected.some((item) => item.issues.some((issue) => issue.code === 'KEEPOUT_COLLISION')), true);
assert.equal(generated.nextRequest.mode, 'plan');

const planned = await viaAction(eda, generated.nextRequest);
assert.equal(planned.status, 'planned');
assert.equal(planned.analysis.applyReady, true);
assert.equal(planned.plan.vias.length, generated.plan.vias.length);
assert.equal(planned.plan.vias.some((via) => via.strategy === 'signal-transition-return' && via.score === 100), true);
assert.equal(planned.applyRequest.mode, 'apply');

const missingEda = createMockEda({ missingLayer16Fill: true });
const missingInspection = await inspectAction(missingEda, { expectedDocumentUuid: 'pcb-stitch-test' });
const blocked = await stitchingAction(missingEda, { mode: 'generate', generation: generation(missingInspection.inspectionFingerprint) });
assert.equal(blocked.status, 'generated-with-blockers');
assert.equal(blocked.plan, null);
assert.equal(blocked.globalIssues.some((issue) => issue.code === 'REALIZED_GROUND_COPPER_MISSING' && issue.layerId === 16), true);

const openEda = createMockEda({ openBoard: true });
const openInspection = await inspectAction(openEda, { expectedDocumentUuid: 'pcb-stitch-test' });
const edgeOnlyGeneration = {
  schemaVersion: 1,
  expectedDocumentUuid: 'pcb-stitch-test',
  expectedInspectionFingerprint: openInspection.inspectionFingerprint,
  net: 'GND',
  via: { holeDiameter: 12, diameter: 24 },
  requiredGroundLayerIds: [15, 16],
  clearance: 10,
  edgeClearance: 10,
  minimumCenterSpacing: 10,
  maxSelected: 4,
  detailLevel: 'full',
  strategies: [
    { type: 'edge-fence', spacing: 100, inset: 40, minimumGroundViaDistance: 0, maxCount: 4 },
  ],
};
const balanced = await stitchingAction(openEda, { mode: 'generate', generation: edgeOnlyGeneration });
assert.equal(balanced.status, 'generated');
assert.equal(balanced.selected.length, 4);
assert.equal(new Set(balanced.selected.map((via) => via.anchor.coverageBin)).size, 4);
assert.equal(balanced.selectionQuality.edgeFences[0].method, 'existing-coverage-seeded-perimeter-bins-then-farthest-point');
assert.equal(balanced.selectionQuality.edgeFences[0].existingEdgeGroundViaCount, 0);
assert.equal(balanced.selectionQuality.edgeFences[0].occupiedBinCount, 4);
assert.equal(balanced.selectionQuality.edgeFences[0].emptyBinCount, 0);
assert.ok(balanced.selectionQuality.edgeFences[0].maximumArcGapFraction <= 0.26);
const balancedRepeat = await stitchingAction(openEda, { mode: 'generate', generation: edgeOnlyGeneration });
assert.deepEqual(
  balancedRepeat.selected.map(({ key, x, y, anchor }) => ({ key, x, y, anchor })),
  balanced.selected.map(({ key, x, y, anchor }) => ({ key, x, y, anchor })),
);

const seededEda = createMockEda({
  openBoard: true,
  viasOverride: [
    { primitiveId: 'edge-gnd-1', net: 'GND', x: 400, y: 40, holeDiameter: 12, diameter: 24 },
    { primitiveId: 'edge-gnd-2', net: 'GND', x: 600, y: 560, holeDiameter: 12, diameter: 24 },
  ],
});
const seededInspection = await inspectAction(seededEda, { expectedDocumentUuid: 'pcb-stitch-test' });
const seeded = await stitchingAction(seededEda, {
  mode: 'generate',
  generation: { ...edgeOnlyGeneration, expectedInspectionFingerprint: seededInspection.inspectionFingerprint },
});
assert.equal(seeded.status, 'generated');
assert.equal(seeded.selectionQuality.edgeFences[0].existingEdgeGroundViaCount, 2);
assert.equal(seeded.selectionQuality.edgeFences[0].selectedCount, 2);
assert.equal(seeded.selectionQuality.edgeFences[0].occupiedBinCount, 4);
assert.equal(seeded.selectionQuality.edgeFences[0].emptyBinCount, 0);
assert.ok(seeded.selectionQuality.edgeFences[0].maximumArcGapFraction <= 0.26);

process.stdout.write('pcb-ground-stitching tests passed\n');
