import { compileCpSatProblem } from './pcb-layout-cpsat-model.mjs';
import { scopeLayoutModel } from './pcb-layout-scope.mjs';
import { transformBox } from './pcb-layout-geometry.mjs';

export function scopeOpenLayoutModel(full, spec = {}) {
  if (!spec.refs?.includes(spec.gaugeRef)) throw Error('INVALID_OPEN_LAYOUT_SCOPE');
  return scopeLayoutModel(full, { ...spec, placementMode: 'open', includeLabels: false, includeStandalonePads: false });
}

export function compileOpenBlockProblem(full, spec, settings = {}) {
  const model = scopeOpenLayoutModel(full, spec);
  const domain = spec.computationalCoordinateMil ?? 2 * [...model.components.keys()].reduce((sum, ref) => sum + model.referenceGeometry.get(ref).longMil + model.mechanical.clearanceMil, 0);
  const initialProposal = { metadata: { mode: 'fresh', source: 'isolated-block-coordinate-gauge' }, components: [...model.components.keys()].map(ref => model.fixed.get(ref) ?? { ref, x: 0, y: 0, rotation: model.allowedRotations.get(ref)[0] }), testPads: [] };
  const problem = compileCpSatProblem(model, { ...settings, displacementWeight: 0 }, { initialProposal, placementMode: 'open', includeLabels: false, computationalCoordinateMil: domain });
  Object.assign(problem, { noInitialHints: true, variantIntervals: true, skipFeasibilityPhase: true,
    criticalPairs: spec.criticalPairs ?? [], boundaryPairs: spec.boundaryPairs ?? [], routingFlowRules: spec.routingFlowRules ?? [], numericToleranceMil: spec.numericToleranceMil ?? 0,
    spacing: [], semanticGroups: [], padIdsByRef: Object.fromEntries(spec.refs.map(ref => [ref, model.pads.filter(p => p.owner === ref).map(p => p.id)])), padNets: Object.fromEntries(model.pads.map(p => [p.id, p.net])) });
  if (spec.criticalPairs?.length) problem.blockObjective = spec.blockObjective ?? 'electrical-only';
  for (const pair of [...problem.criticalPairs, ...problem.boundaryPairs]) {
    if (!Number.isFinite(pair.weight ?? 1) || (pair.weight ?? 1) < 0 || !pair.left?.length || !pair.right?.length) throw Error('INVALID_OPEN_CRITICAL_PAIR');
    for (const endpoint of [...pair.left, ...pair.right]) if (!model.pads.some(p => p.id === endpoint.id && p.owner === endpoint.ref && (pair.net === undefined || pair.net === p.net))) throw Error('OPEN_PAIR_PAD_OR_NET_MISMATCH ' + pair.id);
  }
  for (const key of ['localSearchRegion', 'componentSideRules', 'bodyCoordinateBounds', 'baselineDistanceCaps', 'criticalWorstCapMil', 'blockCompactnessWeight']) if (spec[key] !== undefined) problem[key] = structuredClone(spec[key]);
  for (const zone of spec.reservations ?? []) {
    if (zone.owner && !model.components.has(zone.owner)) throw Error('UNKNOWN_OPEN_RESERVATION_OWNER ' + zone.owner);
    problem.zones.push({ id: zone.id, owner: zone.owner, geometry: zone.geometry ?? 'pads', mode: 'keepout', excludeRefs: zone.excludeRefs ?? (zone.owner ? [zone.owner] : []), allowedNet: zone.allowedNet, ...(zone.owner ? {} : { box: zone.box }) });
    if (zone.owner) for (const v of problem.entities.find(e => e.ref === zone.owner).variants) v.zones[zone.id] = transformBox(zone.box, { x: 0, y: 0, rotation: 0 }, { x: 0, y: 0, rotation: v.rotation });
  }
  problem.coverage.initialization = { mode: 'fresh', poseSource: 'local coordinate gauge and explicitly supplied context', externalInitialHints: 0 };
  problem.coverage.scope = { ...model.modelScope, gaugeRef: spec.gaugeRef, boardOutline: false, nativeSilkscreen: false, computationalCoordinateMil: domain };
  return { model, problem };
}
