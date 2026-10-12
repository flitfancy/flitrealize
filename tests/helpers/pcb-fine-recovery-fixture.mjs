import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixture as nativeFixture } from './pcb-layout-execution-fixture.mjs';
import { prepareFixture } from './pcb-layout-prepare-fixture.mjs';
import { inspectLayout } from '../../scripts/pcb-layout/pcb-layout-execution.mjs';
import { loadLayoutProject } from '../../scripts/pcb-layout/pcb-layout-project.mjs';
import { solveFineLayout } from '../../scripts/pcb-layout/fine/workflow.mjs';
import { routeFineCandidate } from '../../scripts/pcb-layout/fine/routing.mjs';

export async function fineFixture(t, { requiredRouting = false, moveMil = 20 } = {}) {
  const f = await nativeFixture(t), bounds = { minX: 0, minY: 0, maxX: 900, maxY: 300 };
  for (const item of [...f.components, ...f.pads, ...f.attributes]) {
    item.X += 150; item.Y += 100;
    for (const key of ['minX', 'maxX']) item.bbox[key] += 150;
    for (const key of ['minY', 'maxY']) item.bbox[key] += 100;
  }
  f.routing.Polyline.push(f.primitive({ PrimitiveId: 'board', Layer: 11, Polygon: { getSource: () => [0,0,'L',0,300,900,300,900,0,0,0] } }));
  const snapshot = await inspectLayout(f.options()), inputs = prepareFixture(); inputs.snapshot = snapshot;
  inputs.contract.components = [...snapshot.components.map(c => ({ designator: c.ref, role: 'fixture', includeInPcb: true, pins: [{ number: '1' }] })), { designator: 'TP1', role: 'test point', includeInPcb: true, pins: [{ number: '1' }] }];
  inputs.contract.blocks = [{ id: 'fixture', purpose: 'mock only', components: ['U1', 'U2'] }];
  inputs.contract.nets = [{ name: 'N0', kind: 'signal', endpoints: [{ component: 'U1', pin: '1' }, { component: 'TP1', pin: '1' }] }, { name: 'N1', kind: 'signal', endpoints: [{ component: 'U2', pin: '1' }] }];
  inputs.contract.constraints = []; inputs.config.hard.boardBounds = bounds;
  inputs.config.contractFile = 'design/contract.json'; inputs.config.mechanicalRulesFile = 'design/mechanical.json';
  inputs.mechanical = { ...f.options().config, boardBounds: bounds };
  await fs.mkdir(path.join(f.projectRoot, 'design'));
  for (const [file, value] of [['design/PCB_LAYOUT_CONSTRAINTS.v1.json', inputs.config], ['design/contract.json', inputs.contract], ['design/mechanical.json', inputs.mechanical]]) await fs.writeFile(path.join(f.projectRoot, file), JSON.stringify(value));
  const loaded = await loadLayoutProject(f.projectRoot);
  Object.assign(inputs, { config: loaded.config, contract: loaded.contract, mechanical: loaded.mechanical });
  const request = { schemaVersion: 1, blockId: 'fixture', movableRefs: ['U1'], fixedRefs: ['U2'], region: { mode: 'available-space', basis: 'Mock scope' }, labels: { mode: 'separate', clearanceMil: 0 }, objective: { retainSource: false } };
  if (requiredRouting) request.routing = { required: true, nets: ['N0'], policy: { layers: [{ id: 1, purpose: 'top-copper' }, { id: 2, purpose: 'bottom-copper' }], nets: [{ net: 'N0', defaultWireWidthMil: 2, preroute: { sourceOwners: ['U1'], allowedLayers: [1] } }] }, options: { clearanceMil: 2, copperEdgeMil: 0, gridMil: 2 } };
  const solveDirectory = path.join(f.projectRoot, 'solve');
  const solved = await solveFineLayout({ inputs, request, directory: solveDirectory, settings: { timeLimitSeconds: 5, resolutionMil: .5 }, executor: async problem => ({ status: 'FEASIBLE', sourceHash: problem.sourceHash, placements: problem.entities.map(entity => {
    if (problem.coverage.stage === 'independent-labels') { const old = snapshot.items.find(label => label.id === entity.id); return { ref: entity.ref, dx: entity.fixed ? 0 : old.original.bbox.minX / problem.settings.resolutionMil, dy: entity.fixed ? 0 : old.original.bbox.minY / problem.settings.resolutionMil, variant: 0 }; }
    return { ref: entity.ref, dx: entity.fixed ? 0 : moveMil / problem.settings.resolutionMil, dy: 0, variant: entity.preferredVariant ?? 0 };
  }), solver: { wallSeconds: 0 } }) });
  assert.equal(solved.result.status, 'candidate-passed', JSON.stringify(solved.result));
  const modify = f.eda.pcb_PrimitiveAttribute.modify;
  f.eda.pcb_PrimitiveAttribute.modify = async (id, values) => {
    const changed = await modify(id, values), item = f.attributes.find(a => a.PrimitiveId === id), old = snapshot.items.find(a => a.id === id);
    if (changed && values.alignMode === 3) item.bbox = { minX: values.x, maxX: values.x + old.width, minY: values.y, maxY: values.y + old.height };
    return changed;
  };
  let routingReceipt;
  if (requiredRouting) {
    const [left, right] = solved.scope.model.pads.filter(p => p.net === 'N0');
    const start = { x: solved.candidate.plan.components.find(c => c.ref === 'U1').x, y: left.y }, end = { x: right.x, y: right.y }, points = [start, { x: start.x, y: 150 }, { x: end.x, y: 150 }, end];
    const copper = { segments: points.slice(1).map((point, i) => ({ id: 'trial-' + i, net: 'N0', layer: 1, width: 2, x1: points[i].x, y1: points[i].y, x2: point.x, y2: point.y })), vias: [] };
    routingReceipt = await routeFineCandidate({ scope: solved.scope, candidate: solved.candidate, directory: path.join(f.projectRoot, 'route'), runner: async () => ({ candidate: copper }) });
    assert.equal(routingReceipt.status, 'passed', JSON.stringify(routingReceipt.verification));
  }
  return { f, inputs, request, solved, solveDirectory, routingReceipt, input: { inputs, request, candidate: solved.candidate, result: solved.result } };
}
