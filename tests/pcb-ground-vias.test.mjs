import assert from 'node:assert/strict';

import { loadAction } from './helpers/action-harness.mjs';

const inspectAction = await loadAction('pcb-grounding-inspect', 'easyeda-pro');
const viaAction = await loadAction('pcb-ground-vias', 'easyeda-pro');

function sourceRecord(type, id, data) {
  return `${JSON.stringify({ type, id })}||${JSON.stringify(data)}|\n`;
}

function polygon(source, points) {
  return {
    getSource() {
      return structuredClone(source);
    },
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
    getState_ViaType: () => state.viaType,
    getState_PrimitiveLock: () => state.primitiveLock,
  };
}

function createMockEda({ footprintKeepout = false, withTargetComponent = false } = {}) {
  const vias = [];
  let nextId = 1;
  const keepoutPolygon = polygon(
    ['R', 100, 100, 200, 200, 0, 0],
    [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }],
  );
  const documentSource = sourceRecord('PRIMITIVE', '["PRIMITIVE","PROHIBITEDREGION"]', { display: true, pick: true });
  const footprintSource = footprintKeepout
    ? sourceRecord('REGION', 'footprint-region', { ruleType: [5], polygon: ['R', 0, 0, 40, 40, 0, 0] })
    : sourceRecord('PAD', 'pad-1', { x: 0, y: 0 });
  const targetPad = {
    getState_PrimitiveId: () => 'u1-pad-1',
    getState_ParentComponentPrimitiveId: () => 'component-u1',
    getState_Net: () => 'GND',
    getState_PadNumber: () => '1',
    getState_X: () => 400,
    getState_Y: () => 400,
    getState_Pad: () => ['RECTANGLE', 40, 20, 0],
  };
  const targetComponent = {
    getState_PrimitiveId: () => 'component-u1',
    getState_Designator: () => 'U1',
    getState_Name: () => 'Target IC',
    getState_Footprint: () => ({ uuid: 'footprint-test', libraryUuid: 'library-test', name: 'Target' }),
    getState_Layer: () => 1,
    getState_X: () => 400,
    getState_Y: () => 400,
    getState_Rotation: () => 0,
    getState_Pads: () => [{ primitiveId: 'u1-pad-1', padNumber: '1', net: 'GND' }],
    async getAllPins() {
      return [targetPad];
    },
  };

  return {
    dmt_SelectControl: {
      async getCurrentDocumentInfo() {
        return { uuid: 'pcb-via-test', tabId: 'pcb-via-test@project-test', documentType: 3, parentProjectUuid: 'project-test' };
      },
    },
    dmt_Project: {
      async getCurrentProjectInfo() {
        return { uuid: 'project-test', name: 'test/project', friendlyName: 'Via Test' };
      },
    },
    pcb_PrimitivePour: {
      async getAll() {
        return [{
          getState_PrimitiveId: () => 'pour-gnd',
          getState_Net: () => 'GND',
          getState_Layer: () => 1,
          getState_PourName: () => 'Top GND',
          getState_PourFillMethod: () => 'solid',
          getState_PreserveSilos: () => false,
          getState_PourPriority: () => 5,
          getState_LineWidth: () => 10,
          getState_ComplexPolygon: () => polygon(
            ['R', 0, 0, 1000, 1000, 0, 0],
            [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }],
          ),
        }];
      },
    },
    pcb_PrimitiveRegion: {
      async getAll() {
        return [{
          getState_PrimitiveId: () => 'region-keepout',
          getState_Layer: () => 1,
          getState_RegionName: () => 'Keepout',
          getState_RuleType: () => [5, 7],
          getState_LineWidth: () => 10,
          getState_ComplexPolygon: () => keepoutPolygon,
        }];
      },
    },
    pcb_PrimitiveVia: {
      async getAll() {
        return vias.map(viaPrimitive);
      },
      async get(primitiveId) {
        const state = vias.find((item) => item.primitiveId === primitiveId);
        return state ? viaPrimitive(state) : undefined;
      },
      async create(net, x, y, holeDiameter, diameter, viaType, designRuleBlindViaName, solderMaskExpansion, primitiveLock) {
        const state = {
          primitiveId: `created-via-${nextId++}`,
          net,
          x,
          y,
          holeDiameter,
          diameter,
          viaType: viaType ?? 'through',
          designRuleBlindViaName,
          solderMaskExpansion,
          primitiveLock,
        };
        vias.push(state);
        return viaPrimitive(state);
      },
      async delete(primitiveIds) {
        const ids = new Set(Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds]);
        for (let index = vias.length - 1; index >= 0; index -= 1) {
          if (ids.has(vias[index].primitiveId)) vias.splice(index, 1);
        }
        return true;
      },
    },
    pcb_PrimitiveComponent: {
      async getAll() {
        return withTargetComponent ? [targetComponent] : [];
      },
    },
    sys_FileManager: {
      async getDocumentSource() {
        return documentSource;
      },
      async getDocumentFootprintSources() {
        return [{ footprintUuid: 'footprint-test', documentSource: footprintSource }];
      },
    },
  };
}

function createReadbackFailureEda() {
  const eda = createMockEda();
  const originalGet = eda.pcb_PrimitiveVia.get;
  let failNextReadback = true;
  eda.pcb_PrimitiveVia.get = async (primitiveId) => {
    const primitive = await originalGet(primitiveId);
    if (!primitive || !failNextReadback) return primitive;
    failNextReadback = false;
    return {
      ...primitive,
      getState_Diameter: () => 99,
    };
  };
  return eda;
}

function createCoordinateRoundoffEda() {
  const eda = createMockEda();
  const originalGet = eda.pcb_PrimitiveVia.get;
  eda.pcb_PrimitiveVia.get = async (primitiveId) => {
    const primitive = await originalGet(primitiveId);
    if (!primitive) return primitive;
    return {
      ...primitive,
      getState_X: () => primitive.getState_X() - 3e-13,
    };
  };
  return eda;
}

function createCircleKeepoutEda() {
  const eda = createMockEda({ withTargetComponent: true });
  eda.pcb_PrimitiveRegion.getAll = async () => [{
    getState_PrimitiveId: () => 'circle-keepout',
    getState_Layer: () => 12,
    getState_RegionName: () => 'Circle Keepout',
    getState_RuleType: () => [5, 7],
    getState_LineWidth: () => 10,
    getState_ComplexPolygon: () => ({
      getSource: () => ['CIRCLE', 440, 400, 20],
      async discretize() {
        throw new Error('Not implemented');
      },
    }),
  }];
  return eda;
}

const eda = createMockEda();
const inspected = await inspectAction(eda, { expectedDocumentUuid: 'pcb-via-test' });

const blockedPlan = {
  schemaVersion: 1,
  expectedDocumentUuid: 'pcb-via-test',
  expectedInspectionFingerprint: inspected.inspectionFingerprint,
  net: 'GND',
  boardContainmentConfirmed: true,
  boardContainmentEvidence: 'Known mock outline',
  localClearanceConfirmed: true,
  localClearanceEvidence: 'Known mock copper geometry',
  vias: [{ key: 'inside-keepout', x: 150, y: 150, holeDiameter: 12, diameter: 24 }],
};
const blocked = await viaAction(eda, { mode: 'plan', plan: blockedPlan });
assert.equal(blocked.status, 'planned-with-blockers');
assert.equal(blocked.analysis.applyReady, false);
assert.equal(blocked.analysis.rejected[0].issues[0].code, 'KEEPOUT_COLLISION');

const plan = {
  ...blockedPlan,
  vias: [
    {
      key: 'u1-gnd-1', x: 500, y: 500, holeDiameter: 12, diameter: 24,
      strategy: 'signal-transition-return', score: 100,
      anchor: { kind: 'signal-via', primitiveId: 'signal-1' },
      rationale: 'Mock GND return',
    },
    { key: 'u1-gnd-2', x: 550, y: 500, holeDiameter: 12, diameter: 24, rationale: 'Mock GND return' },
  ],
};
const planned = await viaAction(eda, { mode: 'plan', plan });
assert.equal(planned.status, 'planned');
assert.equal(planned.analysis.applyReady, true);
assert.equal(planned.analysis.accepted.length, 2);
assert.equal(typeof planned.analysis.planFingerprint, 'string');
assert.equal(planned.plan.vias[0].strategy, 'signal-transition-return');
assert.equal(planned.plan.vias[0].score, 100);
assert.equal(planned.plan.vias[0].anchor.primitiveId, 'signal-1');

const applied = await viaAction(eda, planned.applyRequest);
assert.equal(applied.status, 'applied');
assert.equal(applied.created.length, 2);
assert.equal(applied.saved, false);

const verified = await viaAction(eda, {
  mode: 'verify',
  expectedDocumentUuid: 'pcb-via-test',
  created: applied.created,
});
assert.equal(verified.status, 'verified');

const rolledBack = await viaAction(eda, applied.rollbackRequest);
assert.equal(rolledBack.status, 'rolled-back');

const failureEda = createReadbackFailureEda();
const failureInspection = await inspectAction(failureEda, { expectedDocumentUuid: 'pcb-via-test' });
const failurePlan = { ...plan, expectedInspectionFingerprint: failureInspection.inspectionFingerprint, vias: [plan.vias[0]] };
const failurePlanned = await viaAction(failureEda, { mode: 'plan', plan: failurePlan });
const failedApply = await viaAction(failureEda, failurePlanned.applyRequest);
assert.equal(failedApply.status, 'rolled-back');
assert.equal(failedApply.error.code, 'VIA_READBACK_MISMATCH');
const failureFinal = await viaAction(failureEda, { mode: 'inspect' });
assert.equal(failureFinal.state.viaCount, 0);

const roundoffEda = createCoordinateRoundoffEda();
const roundoffInspection = await inspectAction(roundoffEda, { expectedDocumentUuid: 'pcb-via-test' });
const roundoffPlan = { ...plan, expectedInspectionFingerprint: roundoffInspection.inspectionFingerprint, vias: [plan.vias[0]] };
const roundoffPlanned = await viaAction(roundoffEda, { mode: 'plan', plan: roundoffPlan });
const roundoffApplied = await viaAction(roundoffEda, roundoffPlanned.applyRequest);
assert.equal(roundoffApplied.status, 'applied');

const unresolvedEda = createMockEda({ footprintKeepout: true });
const unresolvedInspection = await inspectAction(unresolvedEda, { expectedDocumentUuid: 'pcb-via-test' });
const unresolvedPlan = {
  ...plan,
  expectedInspectionFingerprint: unresolvedInspection.inspectionFingerprint,
  vias: [{ key: 'candidate', x: 500, y: 500, holeDiameter: 12, diameter: 24 }],
};
const unresolved = await viaAction(unresolvedEda, { mode: 'plan', plan: unresolvedPlan });
assert.equal(unresolved.status, 'planned-with-blockers');
assert.equal(unresolved.analysis.globalIssues.some((issue) => issue.code === 'FOOTPRINT_KEEPOUT_GEOMETRY_UNRESOLVED'), true);

const generationEda = createMockEda({ withTargetComponent: true });
const generationInspection = await inspectAction(generationEda, { expectedDocumentUuid: 'pcb-via-test' });
const generation = {
  schemaVersion: 1,
  expectedDocumentUuid: 'pcb-via-test',
  expectedInspectionFingerprint: generationInspection.inspectionFingerprint,
  net: 'GND',
  via: { holeDiameter: 12, diameter: 24 },
  directions: ['right', 'left', 'down', 'up'],
  targets: [{ designator: 'U1', padNumbers: ['1'], countPerPad: 1 }],
  padGap: 10,
};
const generatedBlocked = await viaAction(generationEda, { mode: 'generate', generation });
assert.equal(generatedBlocked.status, 'generated-with-blockers');
assert.equal(generatedBlocked.selectedCount, 1);
assert.equal(generatedBlocked.analysis.globalIssues.some((issue) => issue.code === 'BOARD_CONTAINMENT_NOT_CONFIRMED'), true);
assert.equal(generatedBlocked.analysis.globalIssues.some((issue) => issue.code === 'LOCAL_COPPER_CLEARANCE_NOT_CONFIRMED'), true);

const generatedReady = await viaAction(generationEda, {
  mode: 'generate',
  generation: {
    ...generation,
    boardContainmentConfirmed: true,
    boardContainmentEvidence: 'Known mock outline',
    localClearanceConfirmed: true,
    localClearanceEvidence: 'Known mock copper geometry',
    detailLevel: 'full',
  },
});
assert.equal(generatedReady.status, 'generated');
assert.equal(generatedReady.plan.vias[0].key, 'U1-pad1-right');
assert.equal(generatedReady.applyRequest.mode, 'apply');

const circleKeepoutEda = createCircleKeepoutEda();
const circleInspection = await inspectAction(circleKeepoutEda, { expectedDocumentUuid: 'pcb-via-test' });
const circleGenerated = await viaAction(circleKeepoutEda, {
  mode: 'generate',
  generation: {
    ...generation,
    expectedInspectionFingerprint: circleInspection.inspectionFingerprint,
    boardContainmentConfirmed: true,
    boardContainmentEvidence: 'Known mock outline',
    localClearanceConfirmed: true,
    localClearanceEvidence: 'Known mock copper geometry',
    detailLevel: 'full',
  },
});
assert.equal(circleGenerated.proposalAnalysis.globalIssues.length, 0);
assert.equal(circleGenerated.proposalAnalysis.rejected[0].candidate.key, 'U1-pad1-right');
assert.equal(circleGenerated.proposalAnalysis.rejected[0].issues[0].code, 'KEEPOUT_COLLISION');
assert.equal(circleGenerated.status, 'generated');

const tightAlternativeEda = createMockEda({ withTargetComponent: true });
tightAlternativeEda.pcb_PrimitiveRegion.getAll = async () => [{
  getState_PrimitiveId: () => 'right-only-keepout',
  getState_Layer: () => 12,
  getState_RuleType: () => [7],
  getState_ComplexPolygon: () => ({ getSource: () => ['CIRCLE', 440, 400, 10] }),
}];
const tightInspection = await inspectAction(tightAlternativeEda, { expectedDocumentUuid: 'pcb-via-test' });
const tightGenerated = await viaAction(tightAlternativeEda, {
  mode: 'generate',
  generation: {
    ...generation,
    expectedInspectionFingerprint: tightInspection.inspectionFingerprint,
    directions: ['right', 'down'],
    padGap: 0,
    boardContainmentConfirmed: true,
    boardContainmentEvidence: 'Known mock outline',
    localClearanceConfirmed: true,
    localClearanceEvidence: 'Known mock copper geometry',
    detailLevel: 'full',
  },
});
assert.equal(tightGenerated.proposalAnalysis.rejected[0].candidate.key, 'U1-pad1-right');
assert.equal(tightGenerated.plan.vias[0].key, 'U1-pad1-down');
assert.equal(tightGenerated.status, 'generated');

process.stdout.write('pcb-ground-vias tests passed\n');
