import { fileURLToPath } from 'node:url';
import { transformPoint, transformBox, angle } from './pcb-layout-geometry.mjs';
import { cpSatSettings } from './pcb-layout-cpsat-model.mjs';
import { executeCpSat } from './pcb-layout-cpsat.mjs';
import { conductiveGap } from '../pcb-routing/geometry.mjs';
import { layoutCopperLayers } from './pcb-layout-provider.mjs';
import { buildGeometryViews } from './pcb-layout-geometry-views.mjs';
import { scopeLayoutModel } from './pcb-layout-scope.mjs';
import { validateRigidBlockPublicModel } from './pcb-layout-blocks-model.mjs';
export { createRigidBlockAtlas, validateRigidBlockPublicModel } from './pcb-layout-blocks-model.mjs';

export const blockBackendPath = fileURLToPath(new URL('./pcb-layout-blocks.py', import.meta.url));
const zero = { x: 0, y: 0, rotation: 0 };
const keys = ['minX', 'minY', 'maxX', 'maxY'];
const boxOK = b => b && keys.every(k => Number.isFinite(b[k])) && b.minX < b.maxX && b.minY < b.maxY;
const axisGap = (a, b) => Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
const rectShape = (box, layers) => ({ kind: 'polygon', points: [[box.minX, box.minY], [box.minX, box.maxY], [box.maxX, box.maxY], [box.maxX, box.minY]], layers });
export function copperShapeBounds(shape) {
  const points = shape.kind === 'polygon' ? shape.points : shape.kind === 'capsule' ? [shape.a, shape.b] : [shape.center], radius = shape.radius ?? 0;
  return { minX: Math.min(...points.map(p => p[0])) - radius, maxX: Math.max(...points.map(p => p[0])) + radius, minY: Math.min(...points.map(p => p[1])) - radius, maxY: Math.max(...points.map(p => p[1])) + radius };
}
function transformShape(shape, pose) {
  const point = p => { const v = transformPoint({ x: p[0], y: p[1] }, zero, pose); return [v.x, v.y]; };
  const out = { ...shape, layers: [...shape.layers] };
  for (const key of ['a', 'b', 'center']) if (shape[key]) out[key] = point(shape[key]);
  if (shape.points) out.points = shape.points.map(point);
  return out;
}
function validCopper(copper) {
  const shape = copper?.shape;
  if (!copper?.id || !shape || !['polygon', 'capsule', 'circle'].includes(shape.kind) || !Array.isArray(shape.layers) || !shape.layers.length) return false;
  const points = shape.kind === 'polygon' ? shape.points : shape.kind === 'capsule' ? [shape.a, shape.b] : [shape.center];
  return Array.isArray(points) && points.length >= (shape.kind === 'polygon' ? 3 : 1) && points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
    && (shape.kind === 'polygon' || Number.isFinite(shape.radius) && shape.radius > 0);
}

// Candidate geometry and pads come from the shared normalized model. Copper
// and layer expansion are supplied explicitly by the existing routing adapter.
export function createRigidBlock(model, candidate, { id, refs = candidate.plan.components.map(p => p.ref), origin = zero, rotations, base = { x: 0, y: 0 }, fixed = false, copper = [], keepouts = [], fanouts = [], padLayers, copperLayers, legacyNativeLayers = false, localVerification } = {}) {
  if (!candidate.validation?.valid || !id || refs.some(ref => !candidate.plan.components.some(p => p.ref === ref))) throw Error('RIGID_BLOCK_REQUIRES_VERIFIED_CANDIDATE_AND_ROTATIONS');
  rotations ??= [0, 90, 180, 270].filter(delta => candidate.plan.components.filter(p => refs.includes(p.ref)).every(p => model.allowedRotations.get(p.ref).includes(angle(p.rotation+delta))));
  if (!Array.isArray(rotations) || !rotations.length) throw Error('RIGID_BLOCK_REQUIRES_PUBLIC_ROTATIONS');
  const selected = new Set(refs), poses = new Map(candidate.plan.components.map(p => [p.ref, p]));
  const diagnostics = [], layerSources = {};
  const layersFor = (item, layers) => {
    try { const result = layoutCopperLayers(model.realization, item, { layers, copperLayers }); layerSources[item.id] = result.source; return result.layers; }
    catch (error) {
      if (!legacyNativeLayers || !Array.isArray(layers) || !layers.length) throw error;
      diagnostics.push({ code: 'LEGACY_NATIVE_COPPER_LAYERS', id: item.id, source: 'explicit caller compatibility opt-in', message: 'Provider-native layer IDs retained; public layer normalization is not verified.' });
      return [...layers];
    }
  };
  const geometry = candidate.metrics?.geometry ?? buildGeometryViews(scopeLayoutModel(model, { refs: candidate.plan.components.map(p => p.ref), includeLabels: candidate.plan.labels.length > 0 }).geometryModel, candidate.plan.components, candidate.plan.labels, candidate.plan.testPads);
  const courtyards = new Map((geometry.assemblyPolicy?.courtyards ?? []).map(p => [p.ref, p.bbox]));
  const localPose = { x: -origin.x, y: -origin.y, rotation: 0 };
  const parts = candidate.plan.components.filter(p => selected.has(p.ref)).map(p => ({ ...p, x: p.x - origin.x, y: p.y - origin.y, body: transformBox(p.body, zero, localPose), ...(courtyards.has(p.ref) ? { courtyard: transformBox(courtyards.get(p.ref), zero, localPose) } : {}) }));
  const pads = model.pads.filter(p => selected.has(p.owner)).map(p => {
    const pose = poses.get(p.owner), from = model.components.get(p.owner), position = transformPoint(p, from, pose);
    return { ...p, x: position.x - origin.x, y: position.y - origin.y, bbox: transformBox(transformBox(p.bbox, from, pose), zero, localPose), layers: layersFor(p, padLayers?.(p) ?? p.layers) };
  });
  const padCopper = pads.map(p => ({ id: p.id, owner: p.owner, net: p.net, type: 'pad', shape: rectShape(p.bbox, p.layers) }));
  const normalizeCopper = c => ({ ...c, shape: transformShape({ ...c.shape, layers: layersFor(c, c.shape.layers) }, localPose) });
  return { id, units: 'mil', refs, parts, pads, rotations, base, fixed, copper: [...padCopper, ...copper.map(normalizeCopper)], keepouts: keepouts.map(normalizeCopper), fanouts: fanouts.map(normalizeCopper),
    sourceHash: model.snapshot.sourceHash, localVerification: localVerification ?? { layoutValid: true, copperVerified: false }, sourceCandidate: candidate.name,
    source: { kind: 'prepared-public-layout-candidate', sourceHash: model.snapshot.sourceHash, provider: model.realization.provider, candidate: candidate.name, layerSources },
    scope: { refs: [...refs], units: 'mil', nativeSilkscreen: false, layerRepresentation: diagnostics.length ? 'legacy-native' : 'public-copper-purposes' }, diagnostics };
}

export function compileRigidBlockProblem(atlas, settings = {}) {
  if (atlas?.units !== undefined && atlas.units !== 'mil') throw Error('INVALID_RIGID_BLOCK_UNITS: expected mil');
  if (!atlas || atlas.sourceHash === undefined || !boxOK(atlas.board) || !Array.isArray(atlas.groups) || !atlas.groups.length || new Set(atlas.groups.map(g => g.id)).size !== atlas.groups.length) throw Error('INVALID_RIGID_BLOCK_ATLAS');
  for (const key of ['bodyGapMil', 'copperGapMil', 'copperEdgeMil']) if (!Number.isFinite(atlas[key]) || atlas[key] < 0) throw Error('INVALID_RIGID_BLOCK_RULE ' + key);
  const groups = structuredClone(atlas.groups), allRefs = [];
  for (const group of groups) {
    if (!group.id || !group.parts?.length || !Array.isArray(group.pads) || !Array.isArray(group.copper) || group.copper.some(c => !validCopper(c)) || !Array.isArray(group.rotations) || !group.rotations.length || new Set(group.rotations).size !== group.rotations.length || group.rotations.some(r => ![0, 90, 180, 270].includes(r))) throw Error('INVALID_RIGID_BLOCK ' + group.id);
    group.base ??= { x: 0, y: 0 }; group.fixed = Boolean(group.fixed); group.keepouts ??= []; group.fanouts ??= [];
    if (group.fixed && group.rotations.length !== 1) throw Error('FIXED_RIGID_BLOCK_REQUIRES_SINGLE_ROTATION ' + group.id);
    if (![group.base.x, group.base.y].every(Number.isFinite) || [...group.keepouts, ...group.fanouts].some(c => !validCopper(c))) throw Error('INVALID_RIGID_BLOCK_BASE_OR_RESERVATION ' + group.id);
    for (const part of group.parts) { if (!part.ref || ![part.x, part.y, part.rotation].every(Number.isFinite) || !boxOK(part.body) || part.courtyard && !boxOK(part.courtyard)) throw Error('INVALID_RIGID_BLOCK_PART ' + group.id); allRefs.push(part.ref); }
    if (group.pads.some(p => !group.parts.some(c => c.ref === p.owner) || !boxOK(p.bbox))) throw Error('INVALID_RIGID_BLOCK_PAD ' + group.id);
    if (group.allowedTransforms?.some(p => ![p.x, p.y].every(Number.isFinite) || !group.rotations.includes(p.rotation))) throw Error('INVALID_RIGID_BLOCK_TRANSFORM_DOMAIN ' + group.id);
    if (group.channelCells && (!Number.isFinite(group.channelCells.gridMil) || group.channelCells.gridMil <= 0 || ![group.channelCells.origin?.x, group.channelCells.origin?.y].every(Number.isFinite) || !Array.isArray(group.channelCells.rows)
      || group.channelCells.rows.some(row => !Array.isArray(row) || row.length !== 3 || row.some(v => !Number.isInteger(v) || v < 0) || row[2] >= group.rotations.length))) throw Error('INVALID_RIGID_BLOCK_CHANNEL_DOMAIN ' + group.id);
  }
  if (new Set(allRefs).size !== allRefs.length || atlas.expectedRefs && (allRefs.length !== atlas.expectedRefs.length || atlas.expectedRefs.some(ref => !allRefs.includes(ref)))) throw Error('RIGID_BLOCK_COVERAGE');
  const byRef = new Set(allRefs), groupIds = new Set(groups.map(g => g.id));
  for (const r of atlas.edges ?? []) {
    const group = groups.find(g => g.parts.some(p => p.ref === r.ref)), sidesOK = side => ['left', 'right', 'bottom', 'top'].includes(side);
    if (!byRef.has(r.ref) || !Number.isFinite(r.maxInsetMil) || r.maxInsetMil < 0 || (r.variantSides ? !group || r.variantSides.length !== group.rotations.length || r.variantSides.some(sides => !Array.isArray(sides) || !sides.length || sides.some(side => !sidesOK(side))) : !sidesOK(r.side))) throw Error('INVALID_RIGID_BLOCK_EDGE');
  }
  for (const r of atlas.separations ?? []) if (!byRef.has(r.a) || !byRef.has(r.b) || r.a === r.b || !Number.isFinite(r.gapMil) || r.gapMil < 0) throw Error('INVALID_RIGID_BLOCK_SEPARATION');
  for (const cut of atlas.cuts ?? []) if (!Number.isFinite(cut.gapMil) || cut.gapMil < 0 || !['a', 'b'].every(side => boxOK(cut[side]?.box) && (!cut[side].group || groupIds.has(cut[side].group)))) throw Error('INVALID_RIGID_BLOCK_CUT');
  if ((atlas.fixedCopper ?? []).some(c => !validCopper(c))) throw Error('INVALID_FIXED_COPPER');
  const defaultNetWeight = atlas.defaultNetWeight ?? 1;
  if (![defaultNetWeight, ...Object.values(atlas.netWeights ?? {})].every(w => Number.isFinite(w) && w >= 0)) throw Error('INVALID_RIGID_BLOCK_NET_WEIGHT');
  const diagnostics = [...(atlas.diagnostics ?? [])];
  if (atlas.source?.kind !== 'prepared-public-layout-model') diagnostics.push({ code: 'LEGACY_EXPLICIT_RIGID_ATLAS', message: 'Rules and conductive layer representation are caller-supplied; public layout rules have not been derived or validated.' });
  return { schemaVersion: 1, kind: 'flitrealize-cpsat-rigid-blocks', sourceHash: atlas.sourceHash, units: 'mil', board: atlas.board, groups, settings: cpSatSettings(settings), bodyGapMil: atlas.bodyGapMil,
    copperGapMil: atlas.copperGapMil, copperEdgeMil: atlas.copperEdgeMil, edges: atlas.edges ?? [], separations: atlas.separations ?? [], cuts: atlas.cuts ?? [], netWeights: atlas.netWeights ?? {}, defaultNetWeight, excludeNets: atlas.excludeNets ?? [],
    source: atlas.source ?? { kind: 'legacy-explicit-atlas', sourceHash: atlas.sourceHash }, scope: atlas.scope ?? { expectedRefs: atlas.expectedRefs ?? allRefs, publicValidationRequired: false }, diagnostics };
}

export function materializeRigidBlocks(atlas, transforms) {
  const parts = [], pads = [], copper = [], keepouts = [], fanouts = [];
  for (const group of atlas.groups) {
    const pose = transforms[group.id];
    if (!pose || ![pose.x, pose.y, pose.rotation].every(Number.isFinite) || !group.rotations.includes(pose.rotation)) throw Error('INVALID_PACKED_TRANSFORM ' + group.id);
    for (const p of group.parts) { const point = transformPoint(p, zero, pose); parts.push({ ...p, x: point.x, y: point.y, rotation: angle(p.rotation + pose.rotation), body: transformBox(p.body, zero, pose), group: group.id }); }
    for (const p of group.pads) { const point = transformPoint(p, zero, pose); pads.push({ ...p, x: point.x, y: point.y, bbox: transformBox(p.bbox, zero, pose), group: group.id }); }
    for (const [key, output] of [['copper', copper], ['keepouts', keepouts], ['fanouts', fanouts]]) for (const c of group[key] ?? []) output.push({ ...c, group: group.id, shape: transformShape(c.shape, pose) });
  }
  copper.push(...(atlas.fixedCopper ?? []).map(c => ({ ...c, group: null, fixed: true })));
  pads.push(...(atlas.standalonePads ?? []).map(p => ({ ...p, group: null, fixed: true })));
  return { parts, pads, copper, keepouts, fanouts, transforms };
}

export function verifyRigidBlockPacking(atlas, transforms, { toleranceMil = 1e-7, model } = {}) {
  // The public verifier accepts only the same complete contract as the solver.
  // Otherwise undefined clearances can silently turn overlap comparisons off.
  const compiled = compileRigidBlockProblem(atlas);
  if (compiled.scope.publicValidationRequired && !model) throw Error('RIGID_BLOCK_PUBLIC_MODEL_REQUIRED');
  if (!Number.isFinite(toleranceMil) || toleranceMil < 0) throw Error('INVALID_RIGID_BLOCK_TOLERANCE');
  const render = materializeRigidBlocks(atlas, transforms), issues = [], cuts = [], groups = new Map(atlas.groups.map(g => [g.id, g]));
  const violation = (code, a, b, gapMil, required) => {
    issues.push({ code, a: a.id ?? a.ref, b: b.id ?? b.ref, groups: [a.group, b.group], gapMil, requiredMil: required });
    if (a.group === b.group) return;
    const side = value => {
      const world = value.shape ? copperShapeBounds(value.shape) : value.body;
      if (!value.group) return { box: world };
      const t = transforms[value.group], inverse = { x: 0, y: 0, rotation: angle(-t.rotation) };
      const shifted = transformBox(world, { x: t.x, y: t.y, rotation: 0 }, zero);
      return { group: value.group, box: transformBox(shifted, zero, inverse) };
    };
    cuts.push({ id: code + '|' + [a.id ?? a.ref, b.id ?? b.ref].sort().join('|'), a: side(a), b: side(b), gapMil: required });
  };
  const inside = (b, margin) => b.minX >= atlas.board.minX + margin - toleranceMil && b.minY >= atlas.board.minY + margin - toleranceMil && b.maxX <= atlas.board.maxX - margin + toleranceMil && b.maxY <= atlas.board.maxY - margin + toleranceMil;
  for (const group of atlas.groups) if (group.fixed && (Math.abs(transforms[group.id].x - (group.base?.x ?? 0)) > toleranceMil || Math.abs(transforms[group.id].y - (group.base?.y ?? 0)) > toleranceMil)) issues.push({ code: 'FIXED_BLOCK', group: group.id });
  const parts = new Map(render.parts.map(p => [p.ref, p]));
  if (atlas.expectedRefs && (parts.size !== atlas.expectedRefs.length || atlas.expectedRefs.some(ref => !parts.has(ref)))) issues.push({ code: 'PART_COVERAGE' });
  for (const p of render.parts) if (!inside(p.body, 0)) issues.push({ code: 'BODY_BOARD_EDGE', ref: p.ref });
  for (let i = 0; i < render.parts.length; i++) for (const b of render.parts.slice(i + 1)) {
    const a = render.parts[i], gap = axisGap(a.body, b.body);
    if (gap < atlas.bodyGapMil - toleranceMil) violation('BODY_CLEARANCE', a, b, gap, atlas.bodyGapMil);
  }
  let minCrossCopperGapMil = Infinity;
  for (let i = 0; i < render.copper.length; i++) {
    const a = render.copper[i]; if (!inside(copperShapeBounds(a.shape), atlas.copperEdgeMil)) issues.push({ code: 'COPPER_BOARD_EDGE', id: a.id, group: a.group });
    for (const b of render.copper.slice(i + 1)) {
      if (a.group === b.group && (a.block ?? a.group) === (b.block ?? b.group) && (a.group !== null || !a.derivedPublicPad && !b.derivedPublicPad) || a.net && a.net === b.net) continue;
      const gap = conductiveGap(a.shape, b.shape); minCrossCopperGapMil = Math.min(minCrossCopperGapMil, gap);
      if (gap < atlas.copperGapMil - toleranceMil) violation('CROSS_COPPER', a, b, gap, atlas.copperGapMil);
    }
  }
  for (const [reservations, code] of [[render.keepouts, 'KEEP_OUT'], [render.fanouts, 'FANOUT_SPACE']]) for (const k of reservations) for (const c of render.copper) {
    if (k.owner && c.owner === k.owner || code === 'FANOUT_SPACE' && (k.group === c.group || k.net && k.net === c.net)) continue;
    const gap = conductiveGap(k.shape, c.shape); if (gap <= toleranceMil) violation(code, k, c, gap, toleranceMil * 2);
  }
  for (const edge of atlas.edges ?? []) {
    const part = parts.get(edge.ref), box = part.body, group = groups.get(part.group), sides = edge.variantSides ? edge.variantSides[group.rotations.indexOf(transforms[part.group].rotation)] : [edge.side];
    const gaps = { left: box.minX - atlas.board.minX, right: atlas.board.maxX - box.maxX, top: box.minY - atlas.board.minY, bottom: atlas.board.maxY - box.maxY }, gap = Math.min(...sides.map(side => gaps[side]));
    if (gap > edge.maxInsetMil + toleranceMil) issues.push({ code: 'EDGE_INTERFACE', ref: edge.ref, gapMil: gap });
  }
  for (const rule of atlas.separations ?? []) if (axisGap(parts.get(rule.a).body, parts.get(rule.b).body) < rule.gapMil - toleranceMil) issues.push({ code: 'PART_SEPARATION', a: rule.a, b: rule.b });
  const localCopperVerified = [...groups.values()].every(g => g.localVerification?.copperVerified === true);
  const publicValidation = model ? validateRigidBlockPublicModel(model, atlas, render) : null;
  if (publicValidation && !publicValidation.valid) issues.push(...publicValidation.issues.map(issue => ({ ...issue, source: 'public layout validator' })));
  return { status: issues.length ? 'failed' : 'geometry-verified', valid: !issues.length, issues, cuts: [...new Map(cuts.map(c => [c.id, c])).values()], render, publicValidation, diagnostics: compiled.diagnostics,
    minCrossCopperGapMil: Number.isFinite(minCrossCopperGapMil) ? minCrossCopperGapMil : null, scope: { ...compiled.scope, publicRulesEvaluated: Boolean(publicValidation), publicRulesVerified: publicValidation?.valid ?? false, localCopperVerified, rigidCopperPreserved: true, interBlockNetsRouted: false, groundVerified: false, nativeDrcRun: false, nativeWrites: 0, representation: 'supplied conductive shapes; pad bounds are conservative proxies when created from layout pads' } };
}

// Preserved bus/copper channels are screened in bulk by the migrated FFT
// raster method. Use the returned cell domains only as search pruning.
export async function filterRigidBlockCopperChannels(atlas, policy, runtime = {}) {
  if (!Number.isFinite(policy?.gridMil) || policy.gridMil <= 0 || !Number.isFinite(policy.clearanceMil) || policy.clearanceMil < 0 || !Array.isArray(policy.layers) || !policy.layers.length || !Array.isArray(policy.fixedCopper) || policy.fixedCopper.some(c => !validCopper(c))) throw Error('INVALID_COPPER_CHANNEL_POLICY');
  const problem = compileRigidBlockProblem(atlas, { timeLimitSeconds: policy.timeLimitSeconds ?? 30 });
  const result = await executeCpSat({ ...problem, operation: 'filter-channels', channelFilter: policy }, { ...runtime, backendPath: blockBackendPath });
  return { ...result, atlas: { ...atlas, fixedCopper: [...(atlas.fixedCopper ?? []), ...policy.fixedCopper], groups: atlas.groups.map(g => result.channels[g.id] ? { ...g, channelCells: result.channels[g.id] } : g) } };
}

// Feedback stays in memory and is returned for evidence/review. No source PCB
// edits, inferred via geometry, GND proof or native DRC are performed here.
export async function runRigidBlockPacking(atlas, settings = {}, { runtime = {}, feedbackRounds = 0, feasibilityOnly = false, onProgress, model } = {}) {
  if (!Number.isInteger(feedbackRounds) || feedbackRounds < 0 || feedbackRounds > 100) throw Error('INVALID_BLOCK_FEEDBACK_ROUNDS');
  if (atlas.scope?.publicValidationRequired && !model) throw Error('RIGID_BLOCK_PUBLIC_MODEL_REQUIRED');
  const working = { ...atlas, cuts: [...(atlas.cuts ?? [])] }, runs = []; let result, verification;
  for (let round = 0; round <= feedbackRounds; round++) {
    const problem = compileRigidBlockProblem(working, settings); problem.feasibilityOnly = feasibilityOnly;
    result = await executeCpSat(problem, { ...runtime, backendPath: blockBackendPath, onProgress });
    if (!['FEASIBLE', 'OPTIMAL'].includes(result.status)) { runs.push({ round, status: result.status, solver: result.solver }); break; }
    verification = verifyRigidBlockPacking(working, result.transforms, { model });
    runs.push({ round, status: result.status, solver: result.solver, valid: verification.valid, issues: verification.issues.length, newCuts: verification.cuts.length });
    onProgress?.({ progress: 'block-feedback', ...runs.at(-1) });
    if (verification.valid || !verification.cuts.length) break;
    const cuts = new Map(working.cuts.map(c => [c.id, c])); let changed = false;
    for (const cut of verification.cuts) if (!cuts.has(cut.id)) { cuts.set(cut.id, cut); changed = true; }
    working.cuts = [...cuts.values()]; if (!changed) break;
  }
  return { status: verification?.valid ? 'geometry-verified' : result?.status === 'FEASIBLE' || result?.status === 'OPTIMAL' ? 'verification-failed' : 'no-candidate', result, verification, cuts: working.cuts, runs,
    scope: { nativeWrites: 0, groundVerified: false, nativeDrcRun: false, optimization: 'rigid geometry and cross-block HPWL proxy' } };
}
