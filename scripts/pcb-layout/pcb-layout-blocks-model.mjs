import { scopeLayoutModel } from './pcb-layout-scope.mjs';
import { transformPoint, transformBox, angle } from './pcb-layout-geometry.mjs';
import { availableEdges } from './pcb-layout-edge.mjs';
import { validatePlan } from './pcb-layout-solver-core.mjs';
import { layoutCopperLayers } from './pcb-layout-provider.mjs';

const zero = { x: 0, y: 0, rotation: 0 };
const same = (a, b) => Math.abs(a.x-b.x) < 1e-7 && Math.abs(a.y-b.y) < 1e-7;
const sameBox = (a, b) => a && b && ['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(a[key]) && Math.abs(a[key]-b[key]) < .001);
const sameLayers = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().every((layer, index) => layer === [...b].sort()[index]);
const padCopper = pad => ({ id: pad.id, owner: pad.owner, net: pad.net, type: 'pad', derivedPublicPad: true, shape: { kind: 'polygon', layers: [...pad.layers], points: [[pad.bbox.minX, pad.bbox.minY], [pad.bbox.minX, pad.bbox.maxY], [pad.bbox.maxX, pad.bbox.maxY], [pad.bbox.maxX, pad.bbox.minY]] } });
const samePadShape = (shape, pad) => shape?.kind === 'polygon' && shape.points?.length === 4 && sameLayers(shape.layers, pad.layers)
  && padCopper(pad).shape.points.every(point => shape.points.some(actual => Array.isArray(actual) && actual.length === 2 && point.every((n, i) => Number.isFinite(actual[i]) && Math.abs(n-actual[i]) < .001)));

function publicPads(model, parts, copperLayers, includeStandalone = false) {
  const poses = new Map(parts.map(part => [part.ref, part]));
  return model.pads.filter(pad => pad.owner ? poses.has(pad.owner) : includeStandalone).map(pad => {
    const original = pad.owner ? model.components.get(pad.owner) : null, pose = poses.get(pad.owner);
    const position = original ? transformPoint(pad, original, pose) : pad;
    const layers = layoutCopperLayers(model.realization, pad, { copperLayers, layers: pad.layers?.every(layer => typeof layer === 'string') ? pad.layers : undefined }).layers;
    return { ...pad, x: position.x, y: position.y, bbox: original ? transformBox(pad.bbox, original, pose) : { ...pad.bbox }, layers, source: 'public model.pads; transformed by declared part pose' };
  });
}

function checkPadDeclaration(actual, expected) {
  if (!expected || actual.owner !== expected.owner || actual.net !== expected.net || String(actual.number) !== String(expected.number)) throw Error('RIGID_BLOCK_PAD_IDENTITY_MISMATCH ' + actual.id);
  if (!sameBox(actual.bbox, expected.bbox) || actual.x !== undefined && (!Number.isFinite(actual.x) || Math.abs(actual.x-expected.x) >= .001) || actual.y !== undefined && (!Number.isFinite(actual.y) || Math.abs(actual.y-expected.y) >= .001)) throw Error('RIGID_BLOCK_PAD_GEOMETRY_MISMATCH ' + actual.id);
}

// Derive backend IR from the same prepared public rules. Copper rules are a
// separate upstream routing input, because the placement model does not own
// copper clearance or pad-to-board copper margin.
export function createRigidBlockAtlas(full, inputGroups, { refs = [...full.components.keys()], copperRules, netWeights, excludeNets, fixedCopper = [], legacyNativeLayers = false } = {}) {
  if (!copperRules || !Number.isFinite(copperRules.copperGapMil) || copperRules.copperGapMil < 0 || !Number.isFinite(copperRules.copperEdgeMil) || copperRules.copperEdgeMil < 0 || !copperRules.source) throw Error('RIGID_BLOCK_ROUTING_RULE_SOURCE_REQUIRED');
  if (!Array.isArray(inputGroups) || !inputGroups.length) throw Error('RIGID_BLOCK_GROUPS_REQUIRED');
  const model = scopeLayoutModel(full, { refs, includeLabels: false }), groups = structuredClone(inputGroups);
  if (!model.config.hard.boardBounds) throw Error('RIGID_BLOCK_BOARD_REQUIRED');
  const coverage = groups.flatMap(g => g.parts.map(p => p.ref));
  if (new Set(coverage).size !== coverage.length || coverage.length !== refs.length || refs.some(ref => !coverage.includes(ref))) throw Error('RIGID_BLOCK_PUBLIC_MODEL_COVERAGE');
  const owner = new Map(), diagnostics = [];
  const normalizeLayers = (item, layers) => {
    try { return layoutCopperLayers(full.realization, item, { layers, copperLayers: copperRules.copperLayers }).layers; }
    catch (error) {
      if (!legacyNativeLayers || !layers?.length) throw error;
      diagnostics.push({ code: 'LEGACY_NATIVE_COPPER_LAYERS', id: item.id, source: 'explicit atlas factory compatibility opt-in', message: 'Native layer representation retained; public layer normalization is not verified.' }); return [...layers];
    }
  };
  for (const group of groups) {
    if (group.sourceHash !== undefined && group.sourceHash !== full.snapshot.sourceHash) throw Error('RIGID_BLOCK_SOURCE_HASH_MISMATCH ' + group.id);
    const rotations = group.rotations ?? [0, 90, 180, 270];
    group.rotations = rotations.filter(delta => group.parts.every(part => {
      const rotation = angle(part.rotation+delta), domain = model.edgeDomains.get(part.ref);
      return model.allowedRotations.get(part.ref)?.includes(rotation) && (!domain || domain.states.some(state => state.rotation === rotation));
    }));
    if (!group.rotations.length) throw Error('RIGID_BLOCK_NO_PUBLIC_ROTATIONS ' + group.id);
    for (const part of group.parts) {
      const original = model.components.get(part.ref);
      if (part.id !== undefined && part.id !== original.id || !sameBox(part.body, transformBox(original.bbox, original, part))) throw Error('RIGID_BLOCK_PART_GEOMETRY_MISMATCH ' + part.ref);
    }
    const actualPads = publicPads(model, group.parts, copperRules.copperLayers), byPad = new Map(actualPads.map(pad => [pad.id, pad]));
    const suppliedPads = group.pads ?? [];
    if (new Set(suppliedPads.map(pad => pad.id)).size !== suppliedPads.length) throw Error('RIGID_BLOCK_PAD_IDENTITY_MISMATCH duplicate');
    for (const pad of suppliedPads) checkPadDeclaration(pad, byPad.get(pad.id));
    for (const item of group.copper ?? []) if (item.type === 'pad' || byPad.has(item.id)) {
      const pad = byPad.get(item.id);
      if (!pad || item.owner !== pad.owner || item.net !== pad.net || item.type !== undefined && item.type !== 'pad') throw Error('RIGID_BLOCK_PAD_COPPER_IDENTITY_MISMATCH ' + item.id);
      const shape = { ...item.shape, layers: normalizeLayers(item, item.shape.layers) };
      if (!samePadShape(shape, pad)) throw Error('RIGID_BLOCK_PAD_COPPER_GEOMETRY_MISMATCH ' + item.id);
    }
    // Caller metadata cannot remove, relabel or reshape a physical terminal.
    group.pads = actualPads;
    group.copper = [...actualPads.map(padCopper), ...(group.copper ?? []).filter(item => !byPad.has(item.id))];
    for (const item of [...group.copper, ...(group.keepouts ?? []), ...(group.fanouts ?? [])]) item.shape.layers = normalizeLayers(item, item.shape.layers);
    group.source = { ...group.source, pads: 'authoritative public model.pads; all pads owned by group parts', padCount: actualPads.length };
    let anchor;
    for (const part of group.parts) {
      owner.set(part.ref, group); const fixed = model.fixed.get(part.ref); if (!fixed) continue;
      const rotation = angle(fixed.rotation-part.rotation), offset = transformPoint(part, zero, { ...zero, rotation });
      const pose = { x: fixed.x-offset.x, y: fixed.y-offset.y, rotation };
      if (!group.rotations.includes(rotation) || anchor && (anchor.rotation !== rotation || !same(anchor, pose))) throw Error('RIGID_BLOCK_FIXED_POSE_CONFLICT ' + group.id);
      anchor = pose;
    }
    if (anchor) {
      if (group.fixed && (group.rotations.length !== 1 || group.rotations[0] !== anchor.rotation || !same(group.base ?? zero, anchor))) throw Error('RIGID_BLOCK_FIXED_POSE_CONFLICT ' + group.id);
      group.fixed = true; group.base = { x: anchor.x, y: anchor.y }; group.rotations = [anchor.rotation];
    }
    group.sourceHash = full.snapshot.sourceHash;
  }
  const edges = model.edgeRules.map(rule => {
    const group = owner.get(rule.ref), part = group.parts.find(p => p.ref === rule.ref);
    return { ref: rule.ref, group: group.id, maxInsetMil: rule.maxInsetMil, variantSides: group.rotations.map(delta => availableEdges(rule, angle(part.rotation+delta))), source: 'public model.edgeRules/' + rule.ref };
  });
  const separations = [...model.pairClearanceMap].map(([key, gapMil]) => { const [a, b] = JSON.parse(key); return { a, b, gapMil, source: 'public model.pairClearanceMap' }; });
  for (const rule of model.spatialRules.relations) if (rule.metric === 'body-gap' && rule.band.hardMinMil !== undefined) separations.push({ a: rule.a, b: rule.anchors[0], gapMil: rule.band.hardMinMil, source: 'public model.spatialRules/' + rule.id });
  const wholeBoard = model.modelScope.wholeBoard;
  const standalonePads = publicPads(model, [], copperRules.copperLayers, true);
  const atlas = { schemaVersion: 1, units: 'mil', sourceHash: full.snapshot.sourceHash, board: model.config.hard.boardBounds, groups, expectedRefs: [...refs],
    bodyGapMil: model.mechanical.clearanceMil, copperGapMil: copperRules.copperGapMil, copperEdgeMil: copperRules.copperEdgeMil, edges, separations,
    netWeights: netWeights ?? Object.fromEntries(model.connectivity.map(net => [net.name, model.config.comparisonWeights.connectivity ?? 0])), excludeNets: excludeNets ?? model.config.connectivity.excludeNets,
    standalonePads, copperLayers: copperRules.copperLayers ?? ['top-copper', 'bottom-copper'],
    fixedCopper: [...fixedCopper.map(item => ({ ...item, shape: { ...item.shape, layers: normalizeLayers(item, item.shape.layers) } })), ...standalonePads.map(padCopper)], diagnostics,
    source: { kind: 'prepared-public-layout-model', provider: full.realization.provider, sourceHash: full.snapshot.sourceHash, placementRules: 'model.config.hard/model.mechanical/model.pairClearanceMap/model.edgeRules/model.spatialRules', copperRules: copperRules.source },
    scope: { ...model.modelScope, wholeBoard, expectedRefs: [...refs], expectedPadIds: model.pads.map(pad => pad.id), padSource: 'authoritative public model.pads', nativeSilkscreen: false, publicValidationRequired: true, layerNormalizationVerified: diagnostics.length === 0, backendRules: 'rigid packing proxy; complete public rules accepted by validatePlan', standalonePads: model.pads.filter(p => !p.owner).map(p => p.id) } };
  return { atlas, model };
}

// The common validator remains authoritative for all public rules, including
// assembly/operation, pin limits, block anchors and spatial rules absent from
// the rigid packing proxy. Labels are explicitly outside this study's scope.
export function validateRigidBlockPublicModel(full, atlas, render) {
  const refs = atlas.expectedRefs ?? render.parts.map(p => p.ref);
  if (atlas.sourceHash !== full.snapshot.sourceHash || refs.some(ref => !full.components.has(ref))) throw Error('RIGID_BLOCK_PUBLIC_MODEL_IDENTITY');
  const model = scopeLayoutModel(full, { refs, includeLabels: false });
  if (render.parts.length !== refs.length || new Set(render.parts.map(p => p.ref)).size !== refs.length || refs.some(ref => !render.parts.some(p => p.ref === ref))) throw Error('RIGID_BLOCK_PUBLIC_MODEL_COVERAGE');
  const components = render.parts.map(p => {
    const original = model.components.get(p.ref);
    return { ...p, id: original.id, dx: p.x-original.x, dy: p.y-original.y, deltaRotation: angle(p.rotation-original.rotation) };
  });
  const testPads = model.pads.filter(p => !p.owner).map(p => ({ ...p, dx: 0, dy: 0 }));
  const plan = { status: 'planned', sourceHash: model.snapshot.sourceHash, boardBounds: model.config.hard.boardBounds, components, labels: [], testPads,
    bundles: [...components.map(p => ({ ref: p.ref, bbox: p.body })), ...testPads.map(p => ({ ref: p.number, bbox: p.bbox }))], issues: [] };
  const validation = validatePlan(model, plan);
  const expectedPads = publicPads(model, components, atlas.copperLayers, true), byPad = new Map(expectedPads.map(pad => [pad.id, pad])), issues = [...validation.issues];
  if (!Array.isArray(render.pads) || render.pads.length !== expectedPads.length || new Set(render.pads.map(pad => pad.id)).size !== expectedPads.length || expectedPads.some(pad => !render.pads.some(actual => actual.id === pad.id))) issues.push({ code: 'PUBLIC_PAD_COVERAGE', expectedPadIds: expectedPads.map(pad => pad.id) });
  for (const pad of render.pads ?? []) {
    try { checkPadDeclaration(pad, byPad.get(pad.id)); }
    catch (error) { issues.push({ code: 'PUBLIC_PAD_IDENTITY_OR_GEOMETRY', id: pad.id, message: error.message }); }
  }
  const terminals = render.copper.filter(item => item.type === 'pad' || byPad.has(item.id));
  if (terminals.length !== expectedPads.length || new Set(terminals.map(item => item.id)).size !== expectedPads.length || expectedPads.some(pad => !terminals.some(item => item.id === pad.id))) issues.push({ code: 'PUBLIC_PAD_COPPER_COVERAGE' });
  for (const terminal of terminals) {
    const pad = byPad.get(terminal.id);
    if (!pad || terminal.owner !== pad.owner || terminal.net !== pad.net || !samePadShape(terminal.shape, pad)) issues.push({ code: 'PUBLIC_PAD_COPPER_IDENTITY_OR_GEOMETRY', id: terminal.id });
  }
  return { ...validation, valid: !issues.length, issues, plan, scope: { ...model.modelScope, expectedRefs: [...refs], expectedPadIds: expectedPads.map(pad => pad.id), nativeSilkscreen: false, publicRulesEvaluated: true, publicRulesVerified: !issues.length } };
}
