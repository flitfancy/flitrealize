// Functional-block stage helpers for the existing CP-SAT pipeline, not a solver.
import { roughLayoutMetrics } from './pcb-layout-rough.mjs';
import { transformBox, angle } from './pcb-layout-geometry.mjs';

const pairKey = (a, b) => JSON.stringify([a, b].sort());
const union = bs => ({ minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) });
const shift = (b, p) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v + p[k.endsWith('X') ? 'x' : 'y']]));
export const blockCenterMetric = { name: 'physical-center-euclidean-16-direction-projection', coefficientScale: 10000,
  directions: [[10000, 0], [9238, 3826], [7071, 7071], [3826, 9238], [0, 10000]], relativeErrorBound: .01936,
  geometry: 'centre of normalized footprint-and-all-owned-pad bounds; excludes courtyard and labels',
  quantization: 'floor(coordinate / resolutionMil + 0.5); absolute centre with rotation offset', coordinateError: 'at most sqrt(2) * resolutionMil per pair' };

export function blockLayoutStageModel(model, policy = model.config.roughLayoutPolicy) {
  const requested = policy?.clearanceMil ?? 16;
  if (!Number.isFinite(requested) || requested < 0) throw Error('INVALID_BLOCK_LAYOUT_CLEARANCE');
  const source = model.mechanical.clearanceMil, effective = Math.max(source, requested);
  const spacing = { requestedMil: requested, requestSource: policy?.clearanceMil === undefined ? 'block-stage-default' : 'roughLayoutPolicy.clearanceMil',
    sourceMechanicalMil: source, effectiveMil: effective, precedence: 'max(stage value, explicit source mechanical hard minimum); stricter assembly and pair requirements remain active', persistentConfigurationChanged: false };
  const assembly = model.assemblyPolicy ? { ...model.assemblyPolicy, absoluteFloorMil: Math.max(model.assemblyPolicy.absoluteFloorMil ?? 0, effective) } : null;
  return { ...model, blockLayoutSpacing: spacing, mechanical: { ...model.mechanical, clearanceMil: effective, ...(assembly ? { assemblyPolicy: assembly } : {}) },
    pairClearanceMap: new Map([...model.pairClearanceMap].map(([key, gap]) => [key, Math.max(gap, effective)])),
    spacingPolicy: model.spacingPolicy ? { ...model.spacingPolicy, absoluteFloorMil: Math.max(model.spacingPolicy.absoluteFloorMil, effective) } : null,
    assemblyPolicy: assembly, geometryModel: { ...model.geometryModel, assemblyPolicy: assembly } };
}

// Reused at selected-candidate acceptance and native readback; source electrical
// and assembly rules continue through the existing validator independently.
export function blockLayoutPhysicalIssues(model, plan, actualPads) {
  const poses=new Map(plan.components.map(p=>[p.ref,p]));
  const pads=actualPads??model.pads.map(p=>p.owner?{...p,bbox:transformBox(p.bbox,model.components.get(p.owner),poses.get(p.owner))}:plan.testPads.find(t=>t.id===p.id)??p);
  const boxes=new Map(plan.components.map(p=>[p.ref,union([p.body??p.bbox??transformBox(model.components.get(p.ref).bbox,model.components.get(p.ref),p),...pads.filter(pad=>pad.owner===p.ref).map(pad=>pad.bbox)])]));
  for(const p of pads.filter(p=>!p.owner))boxes.set(p.number,p.bbox);
  const refs=[...boxes.keys()],issues=[];
  for(let i=0;i<refs.length;i++)for(const b of refs.slice(i+1)){
    const a=refs[i],left=boxes.get(a),right=boxes.get(b),gap=Math.max(left.minX-right.maxX,right.minX-left.maxX,left.minY-right.maxY,right.minY-left.maxY);
    const required=Math.max(model.mechanical.clearanceMil,model.pairClearanceMap.get(pairKey(a,b))??0);
    if(gap<required-1e-7)issues.push({code:'BLOCK_LAYOUT_PHYSICAL_GAP',refs:[a,b],mil:gap,requiredMil:required});
  }
  return issues;
}

export function blockLayoutHardLimitIssues(model, actualPads) {
  const pads=new Map(actualPads.map(p=>[p.id,p])),issues=[];
  for(const [index,limit] of model.limits.entries()){
    const id=limit.id??'source-limit:'+index+':'+limit.a+'/'+limit.b;
    const endpoints=[...limit.left,...limit.right],missing=endpoints.filter(p=>!pads.has(p.id)||!Number.isFinite(pads.get(p.id).x)||!Number.isFinite(pads.get(p.id).y));
    if(missing.length){issues.push({code:'BLOCK_LAYOUT_REQUIRED_PAD_MISSING',id,padIds:missing.map(p=>p.id)});continue;}
    const distance=Math.min(...limit.left.flatMap(a=>limit.right.map(b=>Math.abs(pads.get(a.id).x-pads.get(b.id).x)+Math.abs(pads.get(a.id).y-pads.get(b.id).y))));
    if(distance>limit.maxMil+.001)issues.push({code:'PIN_DISTANCE_LIMIT',id,mil:distance,maxMil:limit.maxMil});
  }
  return issues;
}

export function compileBlockCenterObjective(model, problem, semantic, policy) {
  const entities = new Map(problem.entities.map(e => [e.ref, e])), membership = new Map(semantic.groups.flatMap(g => g.members.map(ref => [ref, g.id])));
  const excluded = new Set(model.contract.nets.filter(n => n.kind === 'ground' || n.name.toUpperCase() === 'GND').map(n => n.name)), edges = new Map();
  const add = (a, b, group, source, net) => {
    if (a === b || !entities.has(a) || !entities.has(b) || excluded.has(net)) return;
    const key = pairKey(a, b);
    if (!edges.has(key)) { const [left, right] = [a, b].sort(); edges.set(key, { id: 'center:' + key, a: left, b: right, groups: [], sources: [], nets: [], sameBlock: membership.get(a) === membership.get(b) }); }
    const edge = edges.get(key);
    if (!edge.groups.includes(group)) edge.groups.push(group);
    if (!edge.sources.includes(source)) edge.sources.push(source);
    if (!edge.nets.includes(net)) edge.nets.push(net);
  };
  for (const link of model.links) add(link.a, link.b, link.group, 'model.links/' + link.id, link.net);
  // Connect real net endpoints sparsely, independent of their old placement.
  // Explicit relations connect endpoints first; only missing bridges are added.
  for (const net of model.connectivity) {
    if (excluded.has(net.name)) continue;
    const refs = [...new Set(net.pads.map(p => p.owner ?? p.number))].filter(r => entities.has(r)).sort();
    const parent = new Map(refs.map(r => [r, r]));
    const root = r => { while (parent.get(r) !== r) r = parent.get(r); return r; };
    const join = (a, b) => { const ra = root(a), rb = root(b); if (ra === rb) return false; parent.set(rb, ra); return true; };
    for (const edge of [...edges.values()]) if (parent.has(edge.a) && parent.has(edge.b)) { join(edge.a, edge.b); add(edge.a, edge.b, 'connectivity', 'Contract.nets/' + net.name, net.name); }
    for (const ref of refs.slice(1)) if (join(refs[0], ref)) add(refs[0], ref, 'connectivity', 'Contract.nets/' + net.name, net.name);
  }
  const keys = [...new Set([...model.config.groups.map(g => g.id), 'connectivity'])];
  const size = ref => { const b = entities.get(ref).variants[0].physical; return Math.sqrt((b.maxX - b.minX) * (b.maxY - b.minY)); };
  const references = Object.fromEntries(keys.map(key => [key, Math.max(1, [...edges.values()].filter(e => e.groups.includes(key)).reduce((sum, e) => sum + (size(e.a) + size(e.b)) / 2, 0))]));
  const groupFactor = policy?.groupCompactnessWeight ?? 1;
  if (!Number.isFinite(groupFactor) || groupFactor < 0) throw Error('INVALID_ROUGH_LAYOUT_POLICY');
  const divisor = keys.reduce((sum, key) => sum + (model.config.comparisonWeights[key] ?? 0), 0);
  const relations = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)).map(edge => ({ ...edge, groups: edge.groups.sort(), factor: edge.sameBlock ? groupFactor : 1,
    weight: Math.max(...edge.groups.map(key => (model.config.comparisonWeights[key] ?? 0) / references[key])) / divisor * (edge.sameBlock ? groupFactor : 1) }));
  problem.blockLayout = { schemaVersion: 1, stage: 'functional-block-layout', spacing: model.blockLayoutSpacing, metric: blockCenterMetric,
    groups: semantic.groups, groupKeys: keys, references, relations, excludedGroundNets: [...excluded], weights: model.config.comparisonWeights,
    deduplication: 'one unordered physical-object pair; strongest normalized category weight, never summed links/net/group objectives',
    sparseNetTopology: 'explicit relations plus deterministic missing bridges; no all-pairs expansion or old-placement tree', independentRegionAllocation: false, derivedRegionsBecomeKeepouts: false };
  problem.links = []; problem.nets = []; problem.spacing = []; problem.semanticGroups = [];
  for (const pair of problem.pairs) pair.physicalGapMil = Math.max(pair.physicalGapMil, pair.gapMil);
  problem.coverage.objective = { electrical: blockCenterMetric, deduplication: problem.blockLayout.deduplication, spacing: 'hard minima only; general uniformity is unscored', semanticGroups: 'confirmed membership; no extra span objective' };
  return problem.blockLayout;
}

// Self-contained: embedded in standalone HTML for identical reweighting.
export function scoreBlockLayoutMetrics(metrics, weights) {
  const keys = metrics.groupKeys, divisor = keys.reduce((n, key) => n + (weights[key] ?? 0), 0);
  if (!(divisor > 0) || keys.some(key => !Number.isFinite(weights[key] ?? 0) || (weights[key] ?? 0) < 0)) throw Error('INVALID_BLOCK_LAYOUT_WEIGHTS');
  const groups = Object.fromEntries(keys.map(key => [key, { mil: 0, count: 0 }]));
  let electrical = 0;
  for (const edge of metrics.relations) {
    const category = [...edge.groups].sort((a, b) => (weights[b] ?? 0) / metrics.references[b] - (weights[a] ?? 0) / metrics.references[a] || a.localeCompare(b))[0];
    const amount = edge.distanceMil * edge.factor;
    groups[category].mil += edge.distanceMil; // Raw geometric observation, before compactness scaling.
    groups[category].count++;
    electrical += amount * (weights[category] ?? 0) / metrics.references[category] / divisor;
  }
  const spatial = metrics.roughScore ?? 0;
  return { electrical, spatial, total: electrical + spatial, groups };
}

export function blockLayoutCandidateMetrics(problem, plan) {
  const policy = problem.blockLayout, unit = problem.settings.resolutionMil;
  const poses = new Map([...plan.components.map(p => [p.ref, p]), ...plan.testPads.map(p => [p.number, { ...p, rotation: 0 }])]);
  const boxes = new Map(), centers = new Map();
  for (const entity of problem.entities) {
    const p = poses.get(entity.ref), v = entity.variants.find(v => angle(v.rotation) === angle(p.rotation));
    if (!v) throw Error('BLOCK_LAYOUT_METRIC_POSE ' + entity.ref);
    boxes.set(entity.ref, shift(v.physical, p));
    const xy = {}, quantized = {};
    for (const axis of ['x', 'y']) {
      const suffix = axis.toUpperCase(), local = (v.physical['min' + suffix] + v.physical['max' + suffix]) / 2;
      xy[axis] = p[axis] + local;
      const offset = v.originOffset?.[axis] ?? 0;
      const delta=(p[axis]-entity.base[axis]-offset)/unit,grid=Math.round(delta);
      // Decoded poses use the exact backend decomposition. An observed baseline
      // can be off-grid: quantize its actual centre once, not its two offsets.
      quantized[axis] = Math.abs(delta-grid)<1e-7 ? grid+Math.floor((entity.base[axis]+offset+local)/unit+.5) : Math.floor(xy[axis]/unit+.5);
    }
    centers.set(entity.ref, { ...xy, quantized });
  }
  const relations = policy.relations.map(edge => {
    const a = centers.get(edge.a), b = centers.get(edge.b), dx = Math.abs(a.quantized.x - b.quantized.x), dy = Math.abs(a.quantized.y - b.quantized.y);
    return { ...edge, distanceMil: Math.max(...policy.metric.directions.map(([x, y]) => x * dx + y * dy)) * unit / policy.metric.coefficientScale,
      euclideanMil: Math.hypot(a.x - b.x, a.y - b.y), centers: [a, b] };
  });
  const rough = problem.roughLayout ? roughLayoutMetrics(problem, plan) : null;
  const metrics = { groupKeys: policy.groupKeys, references: policy.references, relations, metric: { ...policy.metric, coordinateErrorBoundMil: Math.SQRT2 * unit }, roughScore: rough?.weightedScore ?? 0, rough };
  const blocks = policy.groups.map(group => {
    const bounds = union(group.members.map(ref => boxes.get(ref)));
    const connections = relations.filter(e => group.members.includes(e.a) !== group.members.includes(e.b)).map(edge => {
      const from = centers.get(group.members.includes(edge.a) ? edge.a : edge.b), to = centers.get(group.members.includes(edge.a) ? edge.b : edge.a);
      return { relationId: edge.id, nets: edge.nets, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, direction: { x: to.x - from.x, y: to.y - from.y } };
    });
    return { id: group.id, members: [...group.members], bounds, position: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
      memberPoses: group.members.map(ref => ({ ref, x: poses.get(ref).x, y: poses.get(ref).y, rotation: poses.get(ref).rotation })), connections,
      scope: 'derived candidate occupancy; flexible member poses; no allocated elastic region or reserved channel', persistentKeepout: false };
  });
  const physicalIssues = [];
  for (const pair of problem.pairs) {
    const a = boxes.get(pair.a), b = boxes.get(pair.b), gap = Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
    if (gap < pair.physicalGapMil - 1e-7) physicalIssues.push({ code: 'BLOCK_LAYOUT_PHYSICAL_GAP', refs: [pair.a, pair.b], mil: gap, requiredMil: pair.physicalGapMil });
  }
  return { metrics, blocks, physicalIssues };
}

export function applyBlockLayoutObjective(model, problem, candidate, { validatePhysical = true } = {}) {
  const { metrics, blocks, physicalIssues } = blockLayoutCandidateMetrics(problem, candidate.plan), scores = scoreBlockLayoutMetrics(metrics, model.config.comparisonWeights);
  if (validatePhysical && physicalIssues.length) candidate.validation = { ...candidate.validation, valid: false, issues: [...candidate.validation.issues, ...physicalIssues] };
  candidate.plan.clearanceMil=problem.blockLayout.spacing.effectiveMil;
  candidate.blockLayout = { ...problem.blockLayout, blocks };
  candidate.stats = {...candidate.stats, decodedObjective:scores.total, runObjectiveScope:'solver.objective describes run-final placements; decodedObjective describes this candidate'};
  candidate.blockLayoutMetrics = metrics; candidate.comparisonScore = scores.total; candidate.rankingScore = scores.total;
  candidate.scores = { electrical: scores.electrical, spatial: scores.spatial, total: scores.total };
  candidate.semanticCompactnessScore = 0; candidate.roughLayoutScore = metrics.roughScore;
  if (metrics.rough) candidate.roughLayoutMetrics = metrics.rough;
  if (candidate.metrics) {
    candidate.metrics.groups = Object.fromEntries(Object.entries(scores.groups).map(([key, value]) => [key, { ...value, label: model.config.groups.find(g => g.id === key)?.label ?? key }]));
    candidate.metrics.details = metrics.relations.map(e => ({ id: e.id, a: e.a, b: e.b, net: e.nets.join('/'), mil: e.distanceMil, metric: metrics.metric.name }));
    candidate.metrics.scoreReferences = { mode: 'geometry', groups: Object.fromEntries(Object.entries(metrics.references).map(([key, mil]) => [key, { mil }])) };
  }
  return candidate;
}
