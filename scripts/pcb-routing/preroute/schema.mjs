/** Normalized offline pre-route data, in mil. The search backend is two-layer only. */
import defaults from './defaults.json' with { type: 'json' };
export const DEFAULT_ROUTING = Object.freeze(defaults.routing);
export const DEFAULT_VIA = Object.freeze(defaults.via);

function requireValue(ok, name) { if (!ok) throw new Error(`PREROUTE_INPUT:${name}`); }
function number(value, name, minimum = 0) {
  requireValue(Number.isFinite(value) && value >= minimum, name);
}
function layers(value, name, supported) {
  requireValue(Array.isArray(value) && value.length > 0 && new Set(value).size === value.length, name);
  requireValue(value.every(l => Number.isInteger(l) && supported.includes(l)), name);
}
function point(value, name) {
  requireValue(Array.isArray(value) && value.length === 2, name);
  value.forEach((v, i) => requireValue(Number.isFinite(v), `${name}[${i}]`));
}
export function validateShape(shape, name, supported = DEFAULT_ROUTING.layerIds) {
  requireValue(shape && typeof shape === 'object', name);
  layers(shape.layers, `${name}.layers`, supported);
  if (shape.kind === 'polygon') {
    requireValue(Array.isArray(shape.points) && shape.points.length >= 3, `${name}.points`);
    shape.points.forEach((p, i) => point(p, `${name}.points[${i}]`));
  } else if (shape.kind === 'capsule') {
    point(shape.a, `${name}.a`); point(shape.b, `${name}.b`); number(shape.radius, `${name}.radius`);
  } else if (shape.kind === 'circle') {
    point(shape.center, `${name}.center`); number(shape.radius, `${name}.radius`);
  } else throw new Error(`PREROUTE_INPUT:${name}.kind`);
  return shape;
}
export function shapeBounds(shape) {
  const points = shape.points ?? (shape.kind === 'capsule' ? [shape.a, shape.b] : [shape.center]);
  const r = shape.radius ?? 0;
  return { minX: Math.min(...points.map(p => p[0])) - r, minY: Math.min(...points.map(p => p[1])) - r,
    maxX: Math.max(...points.map(p => p[0])) + r, maxY: Math.max(...points.map(p => p[1])) + r };
}
export function wireShape(s) {
  return { kind: 'capsule', a: [s.x1, s.y1], b: [s.x2, s.y2], radius: s.width / 2, layers: [s.layer] };
}
export function viaShape(v) {
  return { kind: 'circle', center: [v.x, v.y], radius: v.diameter / 2, layers: v.layers };
}
export function boxShape(bbox, layerIds) {
  const { minX, minY, maxX, maxY } = bbox;
  return { kind: 'polygon', points: [[minX, minY], [minX, maxY], [maxX, maxY], [maxX, minY]], layers: layerIds };
}
function bounds(value, name) {
  requireValue(value && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(value[k])), name);
  requireValue(value.minX <= value.maxX && value.minY <= value.maxY, name);
}
function objectIds(rows, name) {
  requireValue(Array.isArray(rows), name);
  const ids = new Set();
  rows.forEach((r, i) => {
    requireValue(typeof r.id === 'string' && r.id.length > 0 && !ids.has(r.id), `${name}[${i}].id`);
    ids.add(r.id);
  });
  return ids;
}
export function routingConfig(input) {
  const routing = { ...DEFAULT_ROUTING, ...input.routing };
  const inherited = Object.fromEntries(Object.entries(defaults.viaFromInput).map(([field, source]) => [field, input[source]]));
  const via = { ...DEFAULT_VIA, ...inherited, ...input.via };
  return { routing, via };
}
export function validatePrerouteInput(input, { requireComponentCopper = true } = {}) {
  requireValue(input && typeof input === 'object', 'object');
  requireValue(input.schemaVersion === 1, 'schemaVersion');
  requireValue(input.units === undefined || input.units === 'mil', 'units-must-be-mil');
  for (const key of ['routing', 'via', 'diagnostics', 'ground', 'fanoutOptions', 'verification']) if (input[key] !== undefined) requireValue(input[key] !== null && typeof input[key] === 'object' && !Array.isArray(input[key]), key);
  for (const key of ['parts', 'fanouts', 'keepouts', 'fanoutRequests', 'requestedNets']) if (input[key] !== undefined) requireValue(Array.isArray(input[key]), key);
  const { routing, via } = routingConfig(input);
  requireValue(Array.isArray(routing.layerIds) && routing.layerIds.length === 2 && new Set(routing.layerIds).size === 2,
    'two-layer-backend-requires-exactly-two-layerIds');
  requireValue(routing.layerIds.every(Number.isInteger), 'routing.layerIds');
  point(input.boardMil, 'boardMil'); input.boardMil.forEach((n, i) => number(n, `boardMil[${i}]`, Number.EPSILON));
  number(input.gridMil, 'gridMil', Number.EPSILON); number(input.clearanceMil, 'clearanceMil');
  number(input.copperEdgeMil, 'copperEdgeMil');
  requireValue(input.copperEdgeMil * 2 < Math.min(...input.boardMil), 'copperEdgeMil');
  for (const key of ['bottomWeight', 'viaCostMil', 'maxSeconds', 'maxVisited', 'maxLaunchOptions']) number(routing[key], `routing.${key}`, Number.EPSILON);
  requireValue(routing.bottomWeight >= 1, 'routing.bottomWeight');
  for (const key of ['powerGoalThresholdMil', 'maskWireGuardMil', 'escapeMaxOutsideMil', 'escapeSearchOutsideMil']) number(routing[key], `routing.${key}`);
  requireValue(routing.escapeSearchOutsideMil <= routing.escapeMaxOutsideMil, 'routing.escapeSearchOutsideMil');
  for (const key of ['launchLengthsMil', 'escapeStemsMil', 'escapeTotalsMil', 'escapeShiftsMil']) {
    requireValue(Array.isArray(routing[key]) && routing[key].length > 0 && routing[key].every(Number.isFinite), `routing.${key}`);
  }
  for (const key of ['diameterMil', 'holeMil']) number(via[key], `via.${key}`, Number.EPSILON);
  requireValue(via.holeMil < via.diameterMil, 'via.holeMil');
  for (const key of ['drillPadClearanceMil', 'drillCenterSpacingMil', 'viaCenterSpacingMil']) number(via[key], `via.${key}`);
  requireValue(Array.isArray(input.noiseNets ?? []), 'noiseNets');
  for (const key of ['minimumSensitiveToSwitchMil', 'preferredSensitiveToSwitchMil']) if (input[key] !== undefined) number(input[key], key);
  const sensitiveMinimum = input.minimumSensitiveToSwitchMil ?? input.clearanceMil;
  requireValue(sensitiveMinimum >= input.clearanceMil, 'minimumSensitiveToSwitchMil');
  requireValue((input.preferredSensitiveToSwitchMil ?? sensitiveMinimum) >= sensitiveMinimum, 'preferredSensitiveToSwitchMil');
  const padIds = objectIds(input.pads, 'pads'), wireIds = objectIds(input.segments, 'segments'), viaIds = objectIds(input.vias, 'vias');
  requireValue(new Set([...padIds, ...wireIds, ...viaIds]).size === padIds.size + wireIds.size + viaIds.size, 'copper-ids-must-be-globally-unique');
  input.pads.forEach((p, i) => {
    const label = `pads[${i}]`; requireValue(typeof p.net === 'string', `${label}.net`); bounds(p.bbox, `${label}.bbox`);
    validateShape(p.shape, `${label}.shape`, routing.layerIds);
    requireValue(Array.isArray(p.contactShapes) && p.contactShapes.length > 0, `${label}.contactShapes`);
    p.contactShapes.forEach((s, j) => validateShape(s, `${label}.contactShapes[${j}]`, routing.layerIds));
    requireValue(Array.isArray(p.shapes) && p.shapes.length > 0, `${label}.shapes`);
    p.shapes.forEach((s, j) => validateShape(s, `${label}.shapes[${j}]`, routing.layerIds));
  });
  validateCandidate({ segments: input.segments, vias: input.vias, nets: [] }, input);
  requireValue(Array.isArray(input.fanouts ?? []), 'fanouts');
  (input.fanouts ?? []).forEach((f, i) => { bounds(f.bbox, `fanouts[${i}].bbox`); layers(f.layers, `fanouts[${i}].layers`, routing.layerIds); });
  requireValue(Array.isArray(input.keepouts ?? []), 'keepouts');
  (input.keepouts ?? []).forEach((k, i) => validateShape(k.shape, `keepouts[${i}].shape`, routing.layerIds));
  requireValue(Array.isArray(input.nets), 'nets');
  const names = new Set();
  input.nets.forEach((n, i) => {
    const label = `nets[${i}]`; requireValue(typeof n.net === 'string' && !names.has(n.net), `${label}.net`); names.add(n.net);
    number(n.widthMil, `${label}.widthMil`, Number.EPSILON); number(n.localWidthMil, `${label}.localWidthMil`, Number.EPSILON);
    if (n.priority !== undefined) requireValue(Number.isFinite(n.priority), `${label}.priority`);
    for (const key of ['sensitive', 'baselineConnected', 'pairedHold']) if (n[key] !== undefined) requireValue(typeof n[key] === 'boolean', `${label}.${key}`);
    if (n.escapeMaxOutsideMil !== undefined) number(n.escapeMaxOutsideMil, `${label}.escapeMaxOutsideMil`);
    if (n.allowedLayers !== undefined) layers(n.allowedLayers, `${label}.allowedLayers`, routing.layerIds);
    requireValue(Array.isArray(n.components), `${label}.components`);
    requireValue(n.components.length === 0 ? n.rootIndex === -1 : Number.isInteger(n.rootIndex) && n.rootIndex >= 0 && n.rootIndex < n.components.length, `${label}.rootIndex`);
    n.components.forEach((c, j) => {
      number(c.widthMil, `${label}.components[${j}].widthMil`, Number.EPSILON);
      for (const [key, ids] of [['pads', padIds], ['wires', wireIds], ['vias', viaIds]]) {
        const checkReferences = key === 'pads' || requireComponentCopper;
        requireValue(Array.isArray(c[key]) && c[key].every(id => typeof id === 'string' && (!checkReferences || ids.has(id))), `${label}.components[${j}].${key}`);
        const rows = key === 'pads' ? input.pads : key === 'wires' ? input.segments : input.vias;
        requireValue(c[key].every(id => !checkReferences || rows.find(row => row.id === id).net === n.net), `${label}.components[${j}].${key}.net`);
      }
      if (c.allowedLayers !== undefined) layers(c.allowedLayers, `${label}.components[${j}].allowedLayers`, routing.layerIds);
    });
  });
  requireValue(Array.isArray(input.requestedNets ?? []) && (input.requestedNets ?? []).every(net => names.has(net)), 'requestedNets');
  requireValue(Array.isArray(input.fanoutRequests ?? []), 'fanoutRequests');
  (input.fanoutRequests ?? []).forEach((r, i) => {
    requireValue(padIds.has(r.padId), `fanoutRequests[${i}].padId`);
    if (r.widthMil !== undefined) number(r.widthMil, `fanoutRequests[${i}].widthMil`, Number.EPSILON);
    if (r.priority !== undefined) requireValue(Number.isFinite(r.priority), `fanoutRequests[${i}].priority`);
    if (r.layer !== undefined) layers([r.layer], `fanoutRequests[${i}].layer`, routing.layerIds);
    if (r.normal !== undefined) requireValue(Array.isArray(r.normal) && r.normal.length === 2 && [[1,0],[-1,0],[0,1],[0,-1]].some(n => n[0] === r.normal[0] && n[1] === r.normal[1]), `fanoutRequests[${i}].normal`);
    for (const key of ['depthsMil', 'tangentsMil']) if (r[key] !== undefined) requireValue(Array.isArray(r[key]) && r[key].length > 0 && r[key].every(Number.isFinite), `fanoutRequests[${i}].${key}`);
  });
  return input;
}
export function validateCandidate(candidate, input) {
  const { routing } = routingConfig(input);
  const segments = candidate.segments, vias = candidate.vias;
  objectIds(segments, 'candidate.segments'); objectIds(vias, 'candidate.vias');
  requireValue(new Set([...segments, ...vias].map(row => row.id)).size === segments.length + vias.length, 'candidate.copper-ids');
  segments.forEach((s, i) => {
    requireValue(typeof s.net === 'string', `candidate.segments[${i}].net`);
    for (const k of ['x1', 'y1', 'x2', 'y2']) requireValue(Number.isFinite(s[k]), `candidate.segments[${i}].${k}`);
    number(s.width, `candidate.segments[${i}].width`, Number.EPSILON);
    layers([s.layer], `candidate.segments[${i}].layer`, routing.layerIds);
    if (s.bridgeComponentPadIds !== undefined) requireValue(Array.isArray(s.bridgeComponentPadIds) && s.bridgeComponentPadIds.length > 0 && s.bridgeComponentPadIds.every(id => typeof id === 'string'), `candidate.segments[${i}].bridgeComponentPadIds`);
    for (const key of ['sourcePadId', 'escapePadId', 'escapeGroupId']) if (s[key] !== undefined && s[key] !== null) requireValue(typeof s[key] === 'string', `candidate.segments[${i}].${key}`);
  });
  vias.forEach((v, i) => {
    requireValue(typeof v.net === 'string' && Number.isFinite(v.x) && Number.isFinite(v.y), `candidate.vias[${i}]`);
    number(v.diameter, `candidate.vias[${i}].diameter`, Number.EPSILON); number(v.hole, `candidate.vias[${i}].hole`, Number.EPSILON);
    requireValue(v.hole < v.diameter, `candidate.vias[${i}].hole`); layers(v.layers, `candidate.vias[${i}].layers`, routing.layerIds);
  });
  requireValue(Array.isArray(candidate.nets ?? []), 'candidate.nets');
  return candidate;
}
