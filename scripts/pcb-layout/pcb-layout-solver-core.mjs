import { padOwner } from './pcb-layout-geometry.mjs';
import { makePlan } from './pcb-layout-mechanical-plan.mjs';
import { angle, rotateOffset, transformPoint, transformBox, transformLabel } from './pcb-layout-geometry.mjs';
import { compileEdgeRules, checkEdges, projectEdges } from './pcb-layout-edge.mjs';
import { compileFeatures, checkBlocks } from './pcb-layout-features.mjs';
import { compileSpatial, evaluateSpatial } from './pcb-layout-spatial.mjs';
import { addToArchive } from './pcb-layout-archive.mjs';
import { spacingTranslation } from './pcb-layout-uniformity.mjs';
import { compileGeometryViews, buildGeometryViews } from './pcb-layout-geometry-views.mjs';
import { compileBlockCoupling, evaluateBlockCoupling } from './pcb-layout-block-coupling.mjs';
import { compileSpacingPolicy } from './pcb-layout-spacing-policy.mjs';
import { clearancePairKey, assemblySpacingClearances, evaluateSpacingPolicy } from './pcb-layout-spacing-evaluation.mjs';
import { addCatalogCandidate } from './pcb-layout-catalog-pool.mjs';
import { compileAssemblyPolicy } from './pcb-layout-assembly-policy.mjs';
import { compileReferenceGeometry, compileReferenceScales, scoreReferenceMil } from './pcb-layout-reference-scale.mjs';
import { compileEdgeDomains, decodeEdgePose } from './pcb-layout-edge-domain.mjs';
import { parametersFromEdgePlan, candidateEdgeEnvelope, constructEdgeLayout, edgeAnchorOptions } from './pcb-layout-edge-construction.mjs';
import { layoutRealization } from './pcb-layout-provider.mjs';
import { resolveBoardBounds, boardContains, checkBoardBounds } from './pcb-layout-board.mjs';

const shift = (b, dx, dy) => ({ minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy });
const gapOf = (a, b) => Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const xyMap = cs => new Map(cs.map(c => [c.ref, c]));
export const simpleWeightKeys = ['power', 'sense', 'bypass', 'connectivity', 'uniformity'];

export function compileModel(snapshot, contract, config, mechanical) {
  config = { ...config, scoringMode: config.scoringMode === undefined ? 'simple-v1' : config.scoringMode };
  if (config.scoringMode !== 'simple-v1') throw Error('INVALID_SCORING_MODE: only simple-v1 is supported; migrate explicit historical modes before solving');
  const realization = layoutRealization(snapshot, contract, config.provider, mechanical);
  const board = resolveBoardBounds(realization.board ?? (snapshot.outlines?.length ? { status: 'unsupported' } : null), config.hard.boardBounds, mechanical.boardBounds);
  config = { ...config, hard: { ...config.hard, boardBounds: board.bounds } };
  mechanical = { ...mechanical, boardBounds: board.bounds };
  validateWeights(config.comparisonWeights, config.groups);
  const assemblyPolicy = compileAssemblyPolicy(snapshot, config.assemblyRules);
  const referenceGeometry = compileReferenceGeometry(snapshot, assemblyPolicy);
  const features = compileFeatures(config.componentFeatures, xyMap(snapshot.components), contract, referenceGeometry);
  const probabilities = [config.search.rotationMoveProbability ?? 0, config.search.silkMoveProbability ?? 0, config.search.edgeMoveProbability ?? (features.edgeRules.length ? .1 : 0), config.search.groupMoveProbability ?? 0, config.search.jointMoveProbability ?? 0, config.search.spacingMoveProbability ?? 0];
  if (probabilities.some(p => !Number.isFinite(p) || p < 0) || probabilities.reduce((a, b) => a + b, 0) >= 1) throw Error('INVALID_MOVE_PROBABILITIES');
  const components = xyMap(snapshot.components);
  const geometryModel = compileGeometryViews(snapshot, config.geometryViews);
  const couplingModel = compileBlockCoupling(contract, snapshot, config.blockCoupling, realization);
  const spatialRules = compileSpatial(config.spatial, components, config.geometryViews);
  if (spatialRules.uniformity && spatialRules.uniformity.targetMil - spatialRules.uniformity.toleranceMil < mechanical.clearanceMil) throw Error('UNIFORMITY_BAND_BELOW_HARD_CLEARANCE');
  for (const key of ['jointRepairRadiusMil', 'neighborRadiusMil', 'maxGroupStepMil']) if (config.search[key] !== undefined && (!Number.isFinite(config.search[key]) || config.search[key] < 0)) throw Error('INVALID_SEARCH_DISTANCE ' + key);
  if (config.search.archiveSize !== undefined && (!Number.isInteger(config.search.archiveSize) || config.search.archiveSize < 2 || config.search.archiveSize > 30)) throw Error('INVALID_ARCHIVE_SIZE');
  if (config.search.reportAlternatives !== undefined && (!Number.isInteger(config.search.reportAlternatives) || config.search.reportAlternatives < 0 || config.search.reportAlternatives > 12)) throw Error('INVALID_REPORT_ALTERNATIVES');
  const edgeRules = [...features.edgeRules, ...compileEdgeRules(config.hard.edgePlacement, components)];
  if (new Set(edgeRules.map(r => r.ref)).size !== edgeRules.length) throw Error('DUPLICATE_EDGE_RULE');
  const contractComponents = new Map(contract.components.map(c => [c.designator, c]));
  const pads = snapshot.pads.map(p => {
    const owner = padOwner(p, snapshot.components);
    return { ...p, ref: owner?.ref ?? p.number, owner: owner?.ref, baseRotation: owner?.rotation ?? 0, dx: owner ? p.x - owner.x : 0, dy: owner ? p.y - owner.y : 0 };
  });
  const spacingRefs = [...components.keys(), ...pads.filter(p => !p.owner).map(p => p.number)];
  const spacingPolicy = compileSpacingPolicy(config.spacingPolicy, spacingRefs, { absoluteFloorMil: mechanical.clearanceMil, assemblyPolicy });
  if (assemblyPolicy && spacingPolicy?.source === 'assembly-courtyard') {
    assemblyPolicy.absoluteFloorMil = spacingPolicy.absoluteFloorMil;
    assemblyPolicy.pairClearancesMil = assemblySpacingClearances(spacingPolicy);
  }
  geometryModel.assemblyPolicy = assemblyPolicy;
  const pairClearanceMap = new Map();
  for (const p of mechanical.pairClearancesMil ?? []) {
    const key = clearancePairKey(p.a, p.b);
    pairClearanceMap.set(key, Math.max(pairClearanceMap.get(key) ?? mechanical.clearanceMil, p.hardMinMil));
  }
  const pairClearancesMil = [...pairClearanceMap].map(([key, hardMinMil]) => { const [a, b] = JSON.parse(key); return { a, b, hardMinMil }; });
  const fixed = new Map((config.hard.fixed ?? []).map(f => [f.ref, f]));
  for (const c of snapshot.components) if (c.locked || mechanical.lockedDesignators?.includes(c.ref)) {
    if (!fixed.has(c.ref)) fixed.set(c.ref, { ref: c.ref, x: c.x, y: c.y, rotation: c.rotation });
  }
  for (const f of fixed.values()) {
    const c = components.get(f.ref);
    if (!c || c.x !== f.x || c.y !== f.y || c.rotation !== f.rotation) throw Error('FIXED_POSITION_MISMATCH ' + f.ref);
  }
  const allowedRotations = new Map(snapshot.components.map(c => {
    let deltas = fixed.has(c.ref) || config.hard.preserveRotations ? [0] : config.hard.allowedRotationDeltasByRef?.[c.ref] ?? config.search.rotationDeltas ?? [0, 90, 180, 270];
    if (features.rotations.has(c.ref)) deltas = deltas.filter(d => features.rotations.get(c.ref).includes(d));
    if (!Array.isArray(deltas) || !deltas.length || deltas.some(d => ![0, 90, 180, 270].includes(d)) || !deltas.includes(0)) throw Error('INVALID_ROTATION_OPTIONS ' + c.ref);
    return [c.ref, deltas.map(d => angle(c.rotation + d))];
  }));
  const edgeDomains = compileEdgeDomains(edgeRules, components, allowedRotations, fixed);
  const pick = (ref, net, pin) => {
    const cc = contractComponents.get(ref), cn = contract.nets.find(n => n.name === net);
    if (!components.has(ref) || !cc || !cn) throw Error('UNKNOWN_LINK ' + ref + '/' + net);
    const logicalPins = cn.endpoints.filter(e => e.component === ref && (pin === undefined || String(e.pin) === String(pin))).map(e => String(e.pin));
    const mapping = realization.pinMaps[ref] ?? {};
    const physicalPins = logicalPins.flatMap(p => mapping[p] ?? [p]).map(String);
    const result = pads.filter(p => p.owner === ref && physicalPins.includes(String(p.number)));
    if (!result.length || result.some(p => p.net !== net)) throw Error('PIN_NET_MISMATCH ' + ref + '/' + (pin ?? '*') + '/' + net);
    return result;
  };
  const links = [];
  for (const group of config.groups) for (const link of group.links) for (const net of link.nets) {
    links.push({ id: group.id + ':' + link.a + ':' + (link.aPin ?? '*') + ':' + link.b + ':' + (link.bPin ?? '*') + ':' + net, group: group.id, a: link.a, b: link.b, net, left: pick(link.a, net, link.aPin), right: pick(link.b, net, link.bPin) });
  }
  const connectivity = contract.nets.filter(n => !config.connectivity.excludeNets.includes(n.name)).map(n => ({
    name: n.name, pads: pads.filter(p => p.net === n.name && (p.owner || config.connectivity.includeTestPads))
  })).filter(n => new Set(n.pads.map(p => p.ref)).size > 1);
  const limits = (config.hard.pinDistanceLimits ?? []).map(l => ({ ...l, left: pick(l.a, l.net, l.aPin), right: pick(l.b, l.net, l.bPin) }));
  for (const l of limits) if (!(Number.isFinite(l.maxMil) && l.maxMil >= 0)) throw Error('INVALID_PIN_DISTANCE_LIMIT');
  const model = { snapshot, contract, config, mechanical: { ...mechanical, ...(pairClearancesMil.length ? { pairClearancesMil } : {}), ...(assemblyPolicy ? { assemblyPolicy } : {}), lockedDesignators: [...fixed.keys()], initializeLabels: false }, components, pads, fixed, allowedRotations, edgeRules, blockRules: features.blockRules, spatialRules, geometryModel, couplingModel, spacingPolicy, assemblyPolicy, referenceGeometry, pairClearanceMap, links, connectivity, limits };
  model.realization = realization;
  model.board = board;
  model.edgeDomains = edgeDomains;
  model.scoreReferences = compileReferenceScales(model);
  model.baselineMetrics = measure(model, snapshot.components);
  return model;
}

export function validateWeights(weights, groups) {
  const keys = [...groups.map(g => g.id).filter(id => simpleWeightKeys.includes(id)), 'connectivity', 'uniformity'];
  if (!weights || Object.entries(weights).some(([key, value]) => !keys.includes(key) || !Number.isFinite(value) || value < 0) || !Number.isFinite(Object.values(weights).reduce((a, b) => a + b, 0))) throw Error('INVALID_WEIGHTS: use known keys with finite nonnegative numbers');
  if (![...groups.map(g => g.id), 'connectivity'].some(key => (weights[key] ?? 0) > 0)) throw Error('NO_OBJECTIVE_WEIGHTS');
  return weights;
}

function point(p, positions) {
  if (!p.owner) return { x: p.x, y: p.y };
  const c = positions.get(p.owner);
  const v = rotateOffset(p.dx, p.dy, c.rotation - p.baseRotation);
  return { x: c.x + v.x, y: c.y + v.y };
}
function pairLength(link, positions) {
  let best = Infinity, endpoints;
  for (const a of link.left) for (const b of link.right) {
    const p = point(a, positions), q = point(b, positions), value = manhattan(p, q);
    if (value < best) { best = value; endpoints = [p, q]; }
  }
  return { mil: best, endpoints };
}
export function measure(model, components, labels, bundles, testPads) {
  const positions = xyMap(components), groups = Object.fromEntries(model.config.groups.map(g => [g.id, { label: g.label, mil: 0, count: 0 }]));
  const details = model.links.map(l => {
    const value = pairLength(l, positions);
    groups[l.group].mil += value.mil; groups[l.group].count++;
    return { id: l.id, group: l.group, a: l.a, b: l.b, net: l.net, ...value };
  });
  const currentTestPads = new Map((testPads ?? []).map(p => [p.id, p]));
  const nets = model.connectivity.map(n => {
    const ps = n.pads.map(p => !p.owner && currentTestPads.has(p.id) ? currentTestPads.get(p.id) : point(p, positions));
    return { net: n.name, mil: Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)) + Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)) };
  });
  groups.connectivity = { label: model.config.connectivity.label ?? '参与评分的网络跨度', mil: nets.reduce((sum, n) => sum + n.mil, 0), count: nets.length };
  const displacementMil = components.reduce((sum, c) => sum + manhattan(c, model.components.get(c.ref)), 0) / Math.max(1, components.length);
  const rotatedCount = components.filter(c => angle(c.rotation - model.components.get(c.ref).rotation) !== 0).length;
  const silkRelocatedCount = labels?.filter(l => {
    const old = model.snapshot.items.find(t => t.id === l.id), from = model.components.get(l.owner), to = positions.get(l.owner);
    const expected = transformBox(old.original.bbox, from, to);
    return ['minX', 'maxX', 'minY', 'maxY'].some(k => Math.abs(expected[k] - l.bbox[k]) > .1);
  }).length ?? 0;
  if (!bundles) {
    const texts = labels ?? model.snapshot.items.map(t => ({ owner: t.owner, bbox: transformBox(t.original.bbox, model.components.get(t.owner), positions.get(t.owner)) }));
    bundles = components.map(c => {
      const bs = [c.body ?? c.bbox ?? transformBox(model.components.get(c.ref).bbox, model.components.get(c.ref), c), ...texts.filter(l => l.owner === c.ref).map(l => l.bbox)];
      return { ref: c.ref, bbox: { minX: Math.min(...bs.map(b => b.minX)), maxX: Math.max(...bs.map(b => b.maxX)), minY: Math.min(...bs.map(b => b.minY)), maxY: Math.max(...bs.map(b => b.maxY)) } };
    });
    bundles.push(...model.pads.filter(p => !p.owner).map(p => ({ ref: p.number, bbox: p.bbox })));
  }
  const geometry = buildGeometryViews(model.geometryModel, components, labels, testPads);
  const spatial = evaluateSpatial(model.spatialRules, components, bundles, geometry);
  const coupling = evaluateBlockCoupling(model.couplingModel, components, geometry.pads);
  const spacingPolicy = evaluateSpacingPolicy(model.spacingPolicy, geometry, components.map(c => c.ref));
  if (spacingPolicy?.effective) {
    spatial.penalties.uniformity = spacingPolicy.penalty ?? 0;
    spatial.penalties.spacing = 0; // Old pair hard bounds still validate; do not double-score their old soft bands.
    spatial.uniformity = null;
    for (const r of spatial.relations) if (r.category === 'spacing') r.scored = false;
  }
  return { groups, details, nets, spatial, geometry, coupling, spacingPolicy, ...(model.scoreReferences ? { scoreReferences: model.scoreReferences } : {}), ...(geometry.assemblyPolicy ? { assemblyPolicy: geometry.assemblyPolicy } : {}), displacementMil, rotatedCount, rotationFraction: rotatedCount / Math.max(1, components.length), silkRelocatedCount, silkFraction: silkRelocatedCount / Math.max(1, model.snapshot.items.length) };
}
export function score(model, metrics, weights = model.config.comparisonWeights) {
  return scoreBreakdown(model, metrics, weights).total;
}
export function scoreBreakdown(model, metrics, weights = model.config.comparisonWeights) {
  validateWeights(weights, model.config.groups);
  let sum = 0, divisor = 0;
  for (const [key, group] of Object.entries(metrics.groups)) {
    const weight = weights[key] ?? 0;
    sum += weight * group.mil / scoreReferenceMil(model, key); divisor += weight;
  }
  if (!(divisor > 0)) throw Error('NO_OBJECTIVE_WEIGHTS');
  const electrical = sum / divisor;
  const spatial = (weights.uniformity ?? 0) * (metrics.spatial?.penalties.uniformity ?? 0);
  return { electrical, spatial, total: electrical + spatial };
}
export function objectiveVector(model, metrics) {
  return [...Object.entries(metrics.groups).filter(([key]) => (model.config.comparisonWeights[key] ?? 0) > 0).map(([key, g]) => g.mil / scoreReferenceMil(model, key)), ...((model.config.comparisonWeights.uniformity ?? 0) > 0 ? [metrics.spatial.penalties.uniformity] : [])];
}

// Transform a snapshot in memory. Physical pad offsets and actual label anchors
// are carried from the previous accepted candidate; no EDA writes occur here.
export function translatedSnapshot(model, positions, previousPlan) {
  const target = xyMap(positions), previous = xyMap(previousPlan?.components ?? model.snapshot.components);
  const out = { ...model.snapshot };
  out.components = model.snapshot.components.map(c => {
    const next = target.get(c.ref);
    return { ...c, x: next.x, y: next.y, rotation: next.rotation, bbox: transformBox(c.bbox, c, next) };
  });
  out.pads = model.pads.map(p => {
    const predicted = { ...p };
    // Raw shapes describe the readback pose. A candidate only transforms bbox
    // geometry; do not present the original shape as a transformed observation.
    delete predicted.nativeGeometry;
    if (!p.owner) {
      const prior = previousPlan?.testPads.find(t => t.id === p.id) ?? p;
      return { ...predicted, x: prior.x, y: prior.y, bbox: shift(p.bbox, prior.x - p.x, prior.y - p.y) };
    }
    const next = target.get(p.owner), old = model.components.get(p.owner);
    return { ...predicted, ...transformPoint(p, old, next), bbox: transformBox(p.bbox, old, next) };
  });
  out.items = model.snapshot.items.map(t => {
    const prior = previousPlan?.labels.find(l => l.id === t.id) ?? t.original;
    const prev = previous.get(t.owner), next = target.get(t.owner);
    const transformed = transformLabel(prior, prev, next, model.realization.labelAlignment.bottomLeft);
    return { ...t, original: { x: transformed.x, y: transformed.y, rotation: transformed.rotation, alignMode: transformed.alignMode, bbox: transformed.bbox } };
  });
  return out;
}

export function validatePlan(model, plan) {
  const issues = [...(plan.issues ?? [])], positions = xyMap(plan.components);
  const finiteBox = b => b && ['minX', 'maxX', 'minY', 'maxY'].every(k => Number.isFinite(b[k])) && b.minX <= b.maxX && b.minY <= b.maxY;
  const sameBox = (a, b) => finiteBox(a) && finiteBox(b) && ['minX', 'maxX', 'minY', 'maxY'].every(k => Math.abs(a[k] - b[k]) < .001);
  if (positions.size !== model.components.size || plan.components.length !== model.components.size || plan.labels.length !== model.snapshot.items.length) issues.push({ code: 'PLAN_OBJECT_COUNT' });
  for (const c of plan.components) {
    const old = model.components.get(c.ref);
    const rotationAllowed = old && Number.isFinite(c.rotation) && model.allowedRotations.get(c.ref).includes(angle(c.rotation));
    if (!old || c.id !== old.id || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !rotationAllowed || !finiteBox(c.body)) issues.push({ code: 'PLAN_COMPONENT_INVALID', ref: c.ref });
    if (old && rotationAllowed && (!sameBox(c.body, transformBox(old.bbox, old, c)) || c.dx !== c.x - old.x || c.dy !== c.y - old.y)) issues.push({ code: 'PLAN_DELTA_OR_BODY_INVALID', ref: c.ref });
    const f = model.fixed.get(c.ref);
    if (f && (c.x !== f.x || c.y !== f.y || c.rotation !== f.rotation)) issues.push({ code: 'FIXED_POSITION_CHANGED', ref: c.ref });
  }
  if (new Set(plan.labels.map(l => l.id)).size !== model.snapshot.items.length) issues.push({ code: 'PLAN_LABEL_IDS' });
  for (const l of plan.labels) {
    const old = model.snapshot.items.find(t => t.id === l.id);
    if (!old || l.owner !== old.owner || l.parentId !== old.parentId || !finiteBox(l.bbox)) issues.push({ code: 'PLAN_LABEL_INVALID', id: l.id });
  }
  const originalTP = model.pads.filter(p => !p.owner);
  if (plan.testPads.length !== originalTP.length || new Set(plan.testPads.map(p => p.id)).size !== originalTP.length) issues.push({ code: 'PLAN_TESTPAD_IDS' });
  for (const p of plan.testPads) {
    const old = originalTP.find(t => t.id === p.id);
    if (!old || old.net !== p.net || old.number !== p.number || !finiteBox(p.bbox) || (old.locked && (old.x !== p.x || old.y !== p.y))) issues.push({ code: 'PLAN_TESTPAD_INVALID', id: p.id });
    if (old && (!sameBox(p.bbox, shift(old.bbox, p.x - old.x, p.y - old.y)) || p.dx !== p.x - old.x || p.dy !== p.y - old.y)) issues.push({ code: 'PLAN_TESTPAD_DELTA_INVALID', id: p.id });
  }
  const union = bs => ({ minX: Math.min(...bs.map(b => b.minX)), maxX: Math.max(...bs.map(b => b.maxX)), minY: Math.min(...bs.map(b => b.minY)), maxY: Math.max(...bs.map(b => b.maxY)) });
  const actualBundles = plan.components.map(c => ({ ref: c.ref, bbox: union([c.body, ...plan.labels.filter(l => l.owner === c.ref).map(l => l.bbox)]) })).concat(plan.testPads.map(p => ({ ref: p.number, bbox: p.bbox })));
  if (plan.bundles.length !== actualBundles.length || new Set(plan.bundles.map(b => b.ref)).size !== actualBundles.length) issues.push({ code: 'PLAN_BUNDLE_COUNT' });
  for (const b of actualBundles) if (!sameBox(b.bbox, plan.bundles.find(p => p.ref === b.ref)?.bbox)) issues.push({ code: 'PLAN_BUNDLE_INVALID', ref: b.ref });
  let minimumGapMil = Infinity;
  for (let i = 0; i < actualBundles.length; i++) for (let j = i + 1; j < actualBundles.length; j++) {
    const gap = gapOf(actualBundles[i].bbox, actualBundles[j].bbox); minimumGapMil = Math.min(minimumGapMil, gap);
    const requiredMil = model.pairClearanceMap.get(clearancePairKey(actualBundles[i].ref, actualBundles[j].ref)) ?? model.mechanical.clearanceMil;
    if (gap < requiredMil - .001) issues.push({ code: 'MIN_CLEARANCE_UNSATISFIED', refs: [actualBundles[i].ref, actualBundles[j].ref], mil: gap, requiredMil });
  }
  if (!issues.length) for (const l of model.limits) {
    const length = pairLength(l, positions).mil;
    if (length > l.maxMil) issues.push({ code: 'PIN_DISTANCE_LIMIT', id: l.id, mil: length, maxMil: l.maxMil });
  }
  const boardBounds = model.config.hard.boardBounds;
  if (boardBounds && !sameBox(plan.boardBounds, boardBounds)) issues.push({ code: 'PLAN_BOARD_BOUNDS_MISMATCH' });
  if (boardBounds && !issues.some(i => /INVALID|COUNT|IDS/.test(i.code))) {
    const pads = model.pads.map(p => {
      const old = p.owner ? model.components.get(p.owner) : p;
      const next = p.owner ? positions.get(p.owner) : plan.testPads.find(t => t.id === p.id);
      return { ...p, kind: 'pad', bbox: transformBox(p.bbox, { ...old, rotation: p.owner ? old.rotation : 0 }, { ...next, rotation: p.owner ? next.rotation : 0 }) };
    });
    issues.push(...checkBoardBounds(boardBounds, [...actualBundles.map(b => ({...b,kind:'placement'})), ...pads]));
  }
  const edge = !issues.length ? checkEdges(model.edgeRules, plan.components, boardBounds) : { issues: [], details: [], ...(boardBounds ? { envelope: boardBounds, boundarySource: 'board' } : {}) };
  const block = !issues.length ? checkBlocks(model.blockRules, plan.components) : { issues: [], details: [] };
  const geometry = !issues.length ? buildGeometryViews(model.geometryModel, plan.components, plan.labels, plan.testPads) : null;
  const spatial = geometry ? evaluateSpatial(model.spatialRules, plan.components, plan.bundles, geometry) : { issues: [] };
  const coupling = geometry ? evaluateBlockCoupling(model.couplingModel, plan.components, geometry.pads) : { issues: [] };
  const spacingPolicy = geometry ? evaluateSpacingPolicy(model.spacingPolicy, geometry, plan.components.map(c => c.ref)) : null;
  const assemblyPolicy = geometry?.assemblyPolicy ?? null;
  issues.push(...edge.issues, ...block.issues, ...spatial.issues, ...coupling.issues, ...(assemblyPolicy?.issues ?? []), ...(spacingPolicy?.issues ?? []));
  return { valid: !issues.length, issues, edge, block, spatial, coupling, spacingPolicy, ...(assemblyPolicy ? { assemblyPolicy } : {}), minimumGapMil: Number.isFinite(minimumGapMil) ? minimumGapMil : null };
}

export function buildCandidate(model, positions, previousPlan, preferredLabelSides = {}, repairOptions = {}) {
  const plan = makePlan(translatedSnapshot(model, positions, previousPlan), { ...model.mechanical, preferredLabelSides, ...repairOptions });
  // Pair limits are authoritative in the compiled model/config; avoid copying
  // thousands of identical entries into every sampled candidate.
  delete plan.pairClearancesMil;
  // The mechanical solver used a proposed snapshot. Rebase ALL deltas back to
  // the real original board before handing the plan to the existing writer.
  for (const c of plan.components) { const old = model.components.get(c.ref); c.dx = c.x - old.x; c.dy = c.y - old.y; c.deltaRotation = angle(c.rotation - old.rotation); }
  for (const p of plan.testPads) { const old = model.pads.find(t => t.id === p.id); p.dx = p.x - old.x; p.dy = p.y - old.y; }
  for (const l of plan.labels) {
    const old = model.snapshot.items.find(t => t.id === l.id).original;
    l.changed = Math.abs(l.x - old.x) > .001 || Math.abs(l.y - old.y) > .001 || l.rotation !== old.rotation || l.alignMode !== old.alignMode;
  }
  plan.sourceHash = model.snapshot.sourceHash;
  plan.sourceBefore = model.snapshot.source;
  plan.counts.moved = plan.components.filter(c => Math.abs(c.dx) > .001 || Math.abs(c.dy) > .001).length;
  plan.counts.rotated = plan.components.filter(c => c.deltaRotation !== 0).length;
  plan.counts.labelsChanged = plan.labels.filter(l => l.changed).length;
  plan.counts.testPadsMoved = plan.testPads.filter(p => Math.abs(p.dx) > .001 || Math.abs(p.dy) > .001).length;
  plan.maxMoveMil = Math.max(0, ...plan.components.map(c => Math.hypot(c.dx, c.dy)));
  const validation = validatePlan(model, plan);
  const metrics = validation.valid ? measure(model, plan.components, plan.labels, plan.bundles, plan.testPads) : null;
  if (metrics) plan.counts.silkRelocated = metrics.silkRelocatedCount;
  return { plan, validation, metrics, comparisonScore: metrics ? score(model, metrics) : null };
}

// Inspect the actual snapshot, including invalid placements, without invoking
// any position/label repair. This is also useful before choosing new rules.
export function inspectCandidate(model) {
  const components = model.snapshot.components.map(c => ({ ...c, body: { ...c.bbox }, dx: 0, dy: 0, deltaRotation: 0 }));
  const labels = model.snapshot.items.map(t => ({ ...t.original, id: t.id, owner: t.owner, parentId: t.parentId, type: t.type, text: t.text, fontSize: t.fontSize, lineWidth: t.lineWidth, changed: false }));
  const testPads = model.pads.filter(p => !p.owner).map(p => ({ ...p, dx: 0, dy: 0 }));
  const geometry = buildGeometryViews(model.geometryModel, components, labels, testPads);
  const plan = { status: 'snapshot-inspection', sourceHash: model.snapshot.sourceHash, boardBounds: model.config.hard.boardBounds, components, labels, testPads, bundles: geometry.placement.map(s => ({ ref: s.ref, bbox: s.bbox })), issues: [], counts: { moved: 0, rotated: 0, labelsChanged: 0, silkRelocated: 0, testPadsMoved: 0 }, maxMoveMil: 0 };
  const validation = validatePlan(model, plan), metrics = measure(model, components, labels, plan.bundles, testPads);
  return { name: 'baseline', label: '输入快照布局', plan, validation, metrics, comparisonScore: score(model, metrics), scores: scoreBreakdown(model, metrics), stats: null };
}

export function buildEdgeCandidate(model, positions, previousPlan, preferredLabels = {}, preferredEdges = {}, repairOptions = {}) {
  let target = projectEdges(model, positions, preferredEdges), prior = previousPlan, trial;
  for (let pass = 0; pass < 8; pass++) {
    // Repair may slide a constrained part along its selected edge, but cannot
    // search its normal coordinate independently and then repair it afterwards.
    const edgeCheck = checkEdges(model.edgeRules, target.map(c => ({ ...c, body: transformBox(model.components.get(c.ref).bbox, model.components.get(c.ref), c) })), model.config.hard.boardBounds);
    const axes = Object.fromEntries(edgeCheck.details.filter(e => e.side).map(e => [e.ref, model.fixed.has(e.ref) ? 'none' : ['left','right'].includes(preferredEdges[e.ref] ?? e.side) ? 'y' : 'x']));
    trial = buildCandidate(model, target, prior, preferredLabels, { ...repairOptions, relocationAxesByRef: { ...axes, ...(repairOptions.relocationAxesByRef ?? {}) } });
    if (trial.validation.valid || trial.validation.issues.some(i => !['EDGE_CONSTRAINT_UNSATISFIED', 'BLOCK_DISTANCE_EXCEEDED'].includes(i.code))) return trial;
    const next = projectEdges(model, trial.plan.components, preferredEdges);
    if (next.every((c, i) => c.x === trial.plan.components[i].x && c.y === trial.plan.components[i].y && c.rotation === trial.plan.components[i].rotation)) return trial;
    target = next; prior = trial.plan;
  }
  return trial;
}

function bodyFeasible(model, positions) {
  const bs = positions.map(c => transformBox(model.components.get(c.ref).bbox, model.components.get(c.ref), c));
  if (bs.some(b => !boardContains(model.config.hard.boardBounds, b))) return false;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (gapOf(bs[i], bs[j]) < (model.pairClearanceMap.get(clearancePairKey(positions[i].ref, positions[j].ref)) ?? model.mechanical.clearanceMil) + .05 - .001) return false;
  return true;
}
export function initializeFeasibleLayout(model, preferredEdges = {}, repairOptions = {}) {
  const cost = c => c.validation.issues.reduce((sum, issue) => sum + 1e6 + Math.max(0, (issue.distanceMil ?? issue.insetMil ?? 0) - (issue.maxDistanceMil ?? issue.maxInsetMil ?? 0)), 0);
  let current = buildEdgeCandidate(model, model.snapshot.components, undefined, {}, preferredEdges, repairOptions);
  const trace = [{ operation: 'initial-spacing-repair', issues: current.validation.issues.length }];
  // Interface projection and nearby anchor movement cooperate after spacing
  // grows. Every returned seed must still satisfy the unchanged final rules.
  for (let round = 0; round < 8 && !current.validation.valid; round++) {
    let best = current;
    for (const issue of current.validation.issues.filter(i => i.code === 'BLOCK_DISTANCE_EXCEEDED')) {
      const rule = model.blockRules.find(r => r.ref === issue.ref), part = current.plan.components.find(c => c.ref === issue.ref);
      if (!rule || !part) continue;
      const step = Math.min(160, Math.max(10, Math.ceil((issue.distanceMil - issue.maxDistanceMil) / 5) * 5 + 5));
      for (const grouped of [true, false]) for (const axis of ['x', 'y']) {
        const refs = [...new Set([...rule.anchors, ...(grouped ? model.spatialRules.localGroups.filter(g => rule.anchors.includes(g.anchor)).flatMap(g => g.refs) : [])])];
        if (refs.some(ref => model.fixed.has(ref))) continue;
        const delta = Math.sign(part[axis] - issue.blockCenter[axis]) * step;
        if (!delta) continue;
        const positions = current.plan.components.map(c => ({ ref: c.ref, x: c.x, y: c.y, rotation: c.rotation, ...(refs.includes(c.ref) ? { [axis]: c[axis] + delta } : {}) }));
        const trial = buildEdgeCandidate(model, positions, current.plan, {}, preferredEdges, { maxRelocationMil: Math.min(repairOptions.maxRelocationMil ?? 80, 80), initializeLabels: repairOptions.initializeLabels ?? false });
        if (cost(trial) < cost(best)) best = trial;
        if (best.validation.valid) break;
      }
      if (best.validation.valid) break;
      const edge = model.edgeRules.find(r => r.ref === issue.ref);
      for (const side of edge?.sides ?? []) {
        const trial = buildEdgeCandidate(model, current.plan.components, current.plan, {}, { ...preferredEdges, [issue.ref]: side }, { maxRelocationMil: Math.min(repairOptions.maxRelocationMil ?? 160, 160), initializeLabels: repairOptions.initializeLabels ?? false });
        if (cost(trial) < cost(best)) best = trial;
        if (best.validation.valid) break;
      }
      if (best.validation.valid) break;
    }
    trace.push({ round, issuesBefore: current.validation.issues.length, issuesAfter: best.validation.issues.length });
    if (best === current) break;
    current = best;
  }
  return { ...current, initialization: trace };
}

export function runSearch(model, profile, iterations = model.config.search.iterations, initialPlan) {
  validateWeights(profile.weights, model.config.groups);
  let seed = profile.seed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const movable = model.snapshot.components.filter(c => !model.fixed.has(c.ref)).map(c => c.ref);
  let current = initialPlan ? buildEdgeCandidate(model, initialPlan.components, initialPlan, {}, {}, { maxRelocationMil: 0 }) : buildEdgeCandidate(model, model.snapshot.components);
  // New features may make the unchanged board infeasible. Try alternate sides
  // deterministically to establish a feasible starting state; never relax rules.
  if (!current.validation.valid && model.edgeRules.length) {
    let seedPreferred = {};
    const penalty = candidate => candidate.validation.issues.reduce((n, i) => n + 1e6 + Math.max(0, (i.distanceMil ?? i.insetMil ?? 0) - (i.maxDistanceMil ?? i.maxInsetMil ?? 0)), 0);
    for (let pass = 0; pass < 3 && !current.validation.valid; pass++) {
      let improved = false;
      for (const rule of model.edgeRules.filter(r => !model.fixed.has(r.ref))) for (const side of rule.sides) {
        const preferred = { ...seedPreferred, [rule.ref]: side };
        const trial = buildEdgeCandidate(model, model.snapshot.components, undefined, {}, preferred);
        if (penalty(trial) < penalty(current)) { current = trial; seedPreferred = preferred; improved = true; }
        if (current.validation.valid) break;
      }
      if (!improved) break;
    }
  }
  if (!current.validation.valid) throw Error('INITIAL_GEOMETRY_INVALID ' + JSON.stringify(current.validation.issues.slice(0, 3)));
  let best = current, currentScore = score(model, current.metrics, profile.weights), bestScore = currentScore;
  const archiveLimit = model.config.search.archiveSize ?? 8;
  let archive = addToArchive([], current, objectiveVector(model, current.metrics), archiveLimit);
  const catalogOptions = { limit: model.config.search.catalogPoolSize ?? 0, gridMil: model.config.search.catalogGridMil ?? 20 };
  let catalog = catalogOptions.limit ? addCatalogCandidate([], current, catalogOptions) : [];
  const stats = { iterations, accepted: 0, bestUpdates: 0, bodyRejected: 0, hardRejected: 0, mechanicalEvaluations: 0, rotationProposals: 0, silkProposals: 0, edgeProposals: 0, groupProposals: 0, jointProposals: 0, spacingProposals: 0, spacingLabelTrials: 0, spacingLabelAccepted: 0, spacingAccepted: 0, rotationsAccepted: 0, silkAccepted: 0, edgesAccepted: 0, groupsAccepted: 0, jointAccepted: 0, yieldedComponents: 0, edgePosesConstructed: 0, edgeParameterInfeasible: 0, noOpProposals: 0 };
  if (!movable.length) return { ...best, name: profile.name, label: profile.label, seed: profile.seed, searchScore: bestScore, stats };
  const pick = arr => arr[Math.floor(random() * arr.length)];
  const edgeMovable = model.edgeRules.filter(r => !model.fixed.has(r.ref));
  const movableGroups = model.spatialRules.localGroups.filter(g => g.refs.every(ref => !model.fixed.has(ref)));
  const totalLinkWeight = model.links.reduce((s, l) => s + (profile.weights[l.group] ?? 0), 0);
  const pickLink = () => {
    if (!(totalLinkWeight > 0)) return undefined;
    let remaining = random() * totalLinkWeight;
    for (const l of model.links) { remaining -= profile.weights[l.group] ?? 0; if (remaining < 0) return l; }
    return model.links.at(-1);
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const positions = current.plan.components.map(c => ({ ref: c.ref, x: c.x, y: c.y, rotation: c.rotation })), map = xyMap(positions);
    const edgeParameters = parametersFromEdgePlan(model, current.plan, current.validation.edge);
    const rotationsFor = ref => {
      const parameter = edgeParameters.get(ref);
      return parameter ? model.edgeDomains.get(ref).states.filter(s => s.side === parameter.state.side).map(s => s.rotation) : model.allowedRotations.get(ref);
    };
    const setRotation = (ref, rotation) => {
      const parameter = edgeParameters.get(ref);
      if (parameter) parameter.state = model.edgeDomains.get(ref).states.find(s => s.side === parameter.state.side && angle(s.rotation) === angle(rotation));
      else map.get(ref).rotation = rotation;
    };
    const displace = (ref, dx, dy) => {
      const parameter = edgeParameters.get(ref);
      if (parameter) parameter.alongMil += parameter.state.tangentAxis === 'x' ? dx : dy;
      else { map.get(ref).x += dx; map.get(ref).y += dy; }
    };
    const rotatable = movable.filter(ref => rotationsFor(ref).some(r => angle(r) !== angle(map.get(ref).rotation)));
    const phase = iteration / Math.max(1, iterations - 1), step = Math.max(model.config.search.gridMil, Math.round(model.config.search.maxMoveStepMil * (1 - phase) / model.config.search.gridMil) * model.config.search.gridMil);
    let refs, dx, dy, operation = 'move', preferredLabelSides = {}, preferredEdges = {}, spacingTrial;
    const variable = random(), rotationProbability = model.config.hard.preserveRotations ? 0 : model.config.search.rotationMoveProbability ?? 0, silkProbability = model.config.search.silkMoveProbability ?? 0, edgeProbability = edgeMovable.length ? model.config.search.edgeMoveProbability ?? .1 : 0;
    const groupProbability = movableGroups.length ? model.config.search.groupMoveProbability ?? 0 : 0, jointProbability = model.config.hard.preserveRotations ? 0 : model.config.search.jointMoveProbability ?? 0;
    const spacingProbability = (model.spacingPolicy?.mode === 'active' || model.spatialRules.uniformity) && (profile.weights.uniformity ?? 0) > 0 ? model.config.search.spacingMoveProbability ?? 0 : 0;
    if (variable < rotationProbability) {
      operation = 'rotation';
      if (!rotatable.length) continue;
      const ref = pick(rotatable), options = rotationsFor(ref).filter(r => r !== angle(map.get(ref).rotation));
      if (!options.length) continue;
      setRotation(ref, pick(options)); stats.rotationProposals++;
    } else if (variable < rotationProbability + silkProbability) {
      operation = 'silk';
      const ref = pick(movable), side = current.plan.components.find(c => c.ref === ref).side;
      preferredLabelSides[ref] = pick(['left', 'right', 'top', 'bottom'].filter(s => s !== side)); stats.silkProposals++;
    } else if (variable < rotationProbability + silkProbability + edgeProbability) {
      operation = 'edge';
      const rule = pick(edgeMovable), currentSide = current.validation.edge.details.find(d => d.ref === rule.ref)?.side;
      const domain = model.edgeDomains.get(rule.ref), frame = candidateEdgeEnvelope(model, current.plan, positions);
      const options = domain.states.filter(s => s.side !== currentSide).flatMap(state => {
        const p = decodeEdgePose(domain, state, frame, { alongMil: map.get(rule.ref)[state.tangentAxis], ...edgeAnchorOptions(model, rule.ref, map) });
        return p ? [{ state, alongMil: p.parameters.alongMil, insetMil: 0 }] : [];
      });
      if (!options.length) continue;
      edgeParameters.set(rule.ref, pick(options)); stats.edgeProposals++;
    } else if (variable < rotationProbability + silkProbability + edgeProbability + groupProbability) {
      operation = 'group';
      const group = pick(movableGroups), anchor = map.get(group.anchor ?? group.refs[0]);
      refs = group.refs; stats.groupProposals++;
      const groupStep = Math.min(step, model.config.search.maxGroupStepMil ?? step);
      dx = pick([-1, 0, 1]) * groupStep; dy = pick([-1, 0, 1]) * groupStep;
      // A whole-group turn can preserve internal relations; later single-part
      // proposals remain allowed, so groups never become permanently rigid.
      const delta = !model.config.hard.preserveRotations && random() < .35 ? pick([90, 180, 270]) : 0;
      if (refs.some(ref => !rotationsFor(ref).includes(angle(map.get(ref).rotation + delta)))) continue;
      const center = { ...anchor };
      for (const ref of refs) {
        const c = map.get(ref), offset = rotateOffset(c.x - center.x, c.y - center.y, delta);
        const targetX = center.x + offset.x + dx, targetY = center.y + offset.y + dy;
        displace(ref, targetX - c.x, targetY - c.y); setRotation(ref, angle(c.rotation + delta));
      }
    } else if (variable < rotationProbability + silkProbability + edgeProbability + groupProbability + jointProbability) {
      operation = 'joint';
      if (!rotatable.length) continue;
      const ref = pick(rotatable), c = map.get(ref), options = rotationsFor(ref).filter(r => r !== angle(c.rotation));
      if (!options.length) continue;
      setRotation(ref, pick(options));
      const smallStep = Math.min(step, 20);
      displace(ref, pick([-1, 0, 1]) * smallStep, pick([-1, 0, 1]) * smallStep);
      refs = [ref]; stats.jointProposals++;
    } else if (variable < rotationProbability + silkProbability + edgeProbability + groupProbability + jointProbability + spacingProbability) {
      operation = 'spacing'; stats.spacingProposals++;
      const policyActive = current.metrics.spacingPolicy?.effective;
      const measuredGaps = policyActive ? current.metrics.spacingPolicy.neighbors : current.metrics.spatial.uniformity.edges;
      const gaps = measuredGaps.filter(e => (!model.fixed.has(e.a) || !model.fixed.has(e.b)) && (!policyActive || e.penalty > 0)).sort((a, b) => b.penalty - a.penalty);
      if (!gaps.length) continue;
      const edge = pick(gaps.slice(0, Math.max(6, Math.ceil(gaps.length / 4))));
      const ref = pick([edge.a, edge.b].filter(r => !model.fixed.has(r)));
      refs = [ref];
      // Try the three remaining label sides before moving any component. Only
      // a strict score improvement with unchanged bodies/testpads qualifies.
      const side = current.plan.components.find(c => c.ref === ref).side;
      // Label changes cannot improve physical spacing. Mechanical repair still
      // tries them when a proposed body move needs room for the text.
      for (const alternative of (model.spacingPolicy?.geometry === 'physical' ? [] : ['left', 'right', 'top', 'bottom'].filter(s => s !== side))) {
        const trial = buildEdgeCandidate(model, positions, current.plan, { [ref]: alternative }, {}, { maxRelocationMil: 0, relocatableRefs: [] });
        stats.spacingLabelTrials++; stats.mechanicalEvaluations++;
        if (!trial.validation.valid || trial.plan.components.some(c => c.x !== map.get(c.ref).x || c.y !== map.get(c.ref).y || c.rotation !== map.get(c.ref).rotation) || trial.plan.testPads.some(p => { const old = current.plan.testPads.find(t => t.id === p.id); return p.x !== old.x || p.y !== old.y; })) continue;
        if (trial.metrics.spatial.penalties.uniformity < current.metrics.spatial.penalties.uniformity - 1e-10 && score(model, trial.metrics, profile.weights) < score(model, (spacingTrial ?? current).metrics, profile.weights) - 1e-10) spacingTrial = trial;
      }
      if (!spacingTrial) {
        const targetGap = policyActive ? (edge.distanceMil < edge.neutralMinMil ? edge.neutralMinMil : edge.neutralMaxMil) : model.spatialRules.uniformity.targetMil;
        const c = map.get(ref), delta = spacingTranslation(edge, ref, targetGap, Math.min(step, 20), model.config.search.gridMil);
        displace(ref, delta.dx, delta.dy);
        // Existing allowed angles still apply; translations remain available
        // when rotations are locked or the footprint has a restricted opening.
        const options = rotationsFor(ref).filter(r => r !== angle(c.rotation));
        if (options.length && random() < .2) setRotation(ref, pick(options));
        else if (!delta.dx && !delta.dy) continue;
      }
    } else {
    const link = pickLink(), mode = random();
    if (mode < .6 && link) {
      const ref = model.fixed.has(link.a) ? link.b : model.fixed.has(link.b) ? link.a : random() < .5 ? link.a : link.b;
      if (model.fixed.has(ref)) continue;
      const toward = map.get(ref === link.a ? link.b : link.a), from = map.get(ref);
      refs = [ref];
      dx = Math.sign(toward.x - from.x) * step; dy = Math.sign(toward.y - from.y) * step;
      if (random() < .5) dx = 0; else dy = 0;
    } else {
      const ref = pick(movable); refs = [ref];
      // Move a small connected set together to preserve useful local relations.
      if (mode > .82) refs = [...new Set([ref, ...model.links.filter(l => l.a === ref || l.b === ref).map(l => l.a === ref ? l.b : l.a)])].filter(r => !model.fixed.has(r)).slice(0, 4);
      dx = (Math.floor(random() * 3) - 1) * step; dy = (Math.floor(random() * 3) - 1) * step;
    }
    if (!dx && !dy) continue;
    for (const ref of refs) displace(ref, dx, dy);
    }
    const constructed = constructEdgeLayout(model, positions, edgeParameters, candidateEdgeEnvelope(model, current.plan, positions));
    if (!constructed.valid) { stats.edgeParameterInfeasible++; continue; }
    const projected = constructed.positions; preferredEdges = constructed.preferredSides;
    stats.edgePosesConstructed += constructed.generated;
    if (!spacingTrial && !Object.keys(preferredLabelSides).length && projected.every(c => { const old = current.plan.components.find(p => p.ref === c.ref); return Math.abs(c.x-old.x)<1e-9 && Math.abs(c.y-old.y)<1e-9 && angle(c.rotation)===angle(old.rotation); })) { stats.noOpProposals++; continue; }
    const cooperative = operation === 'joint' || operation === 'group' || (operation === 'spacing' && !spacingTrial);
    if (!cooperative && !bodyFeasible(model, projected)) { stats.bodyRejected++; continue; }
    const repairRadius = model.config.search.jointRepairRadiusMil ?? 60;
    const repairOptions = { maxRelocationMil: repairRadius, relocationAxesByRef: constructed.relocationAxesByRef };
    if (cooperative) {
      const projectedMap = xyMap(projected), centers = refs.map(ref => projectedMap.get(ref)), reach = model.config.search.neighborRadiusMil ?? 160;
      const nearby = current.plan.components.filter(c => !refs.includes(c.ref) && !model.fixed.has(c.ref)).map(c => ({ ref: c.ref, distance: Math.min(...centers.map(p => gapOf(c.body, transformBox(model.components.get(p.ref).bbox, model.components.get(p.ref), p)))) })).filter(c => c.distance <= reach).sort((a, b) => a.distance - b.distance || a.ref.localeCompare(b.ref)).slice(0, 6).map(c => c.ref);
      const testPads = current.plan.testPads.filter(p => centers.some(c => gapOf(p.bbox, transformBox(model.components.get(c.ref).bbox, model.components.get(c.ref), c)) <= reach)).map(p => p.number);
      repairOptions.relocatableRefs = [...refs, ...nearby, ...testPads];
    }
    const trial = spacingTrial ?? buildEdgeCandidate(model, projected, current.plan, preferredLabelSides, preferredEdges, repairOptions);
    if (!spacingTrial) stats.mechanicalEvaluations++;
    // Edge reprojection may invoke several repair passes. Bound the total drift,
    // not merely the radius of each individual repair pass.
    const proposed = xyMap(projected);
    if (trial.plan.components.some(c => Math.max(Math.abs(c.x - proposed.get(c.ref).x), Math.abs(c.y - proposed.get(c.ref).y)) > repairRadius + .001)) { stats.hardRejected++; continue; }
    const priorTestPads = new Map(current.plan.testPads.map(p => [p.id, p]));
    if (trial.plan.testPads.some(p => Math.max(Math.abs(p.x - priorTestPads.get(p.id).x), Math.abs(p.y - priorTestPads.get(p.id).y)) > repairRadius + .001)) { stats.hardRejected++; continue; }
    if (!trial.validation.valid) { stats.hardRejected++; continue; }
    archive = addToArchive(archive, trial, objectiveVector(model, trial.metrics), archiveLimit);
    if (catalogOptions.limit) catalog = addCatalogCandidate(catalog, trial, catalogOptions);
    const trialScore = score(model, trial.metrics, profile.weights), temperature = model.config.search.initialTemperature * (1 - phase) ** 2 + .0001;
    if (trialScore < currentScore || random() < Math.exp((currentScore - trialScore) / temperature)) {
      current = trial; currentScore = trialScore; stats.accepted++;
      if (operation === 'rotation') stats.rotationsAccepted++;
      if (operation === 'silk') stats.silkAccepted++;
      if (operation === 'edge') stats.edgesAccepted++;
      if (operation === 'group') stats.groupsAccepted++;
      if (operation === 'joint') stats.jointAccepted++;
      if (operation === 'spacing') { stats.spacingAccepted++; if (spacingTrial) stats.spacingLabelAccepted++; }
      if (cooperative) stats.yieldedComponents += trial.plan.components.filter(c => !refs.includes(c.ref) && (Math.abs(c.x - proposed.get(c.ref).x) > .001 || Math.abs(c.y - proposed.get(c.ref).y) > .001)).length;
      if (trialScore < bestScore - 1e-10) { best = trial; bestScore = trialScore; stats.bestUpdates++; }
    }
  }
  return { ...best, name: profile.name, label: profile.label, seed: profile.seed, searchScore: bestScore, stats, alternatives: archive.map(e => ({ ...e.candidate, objectives: e.vector, originProfile: profile.name })), ...(catalogOptions.limit ? { catalog: catalog.map(e => ({ ...e.candidate, originProfile: profile.name, seed: profile.seed })) } : {}) };
}
