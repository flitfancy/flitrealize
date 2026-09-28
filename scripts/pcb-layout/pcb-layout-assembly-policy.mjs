// Rule input uses millimetres; native geometry and all compiled values use mil.
// This module deliberately never reads refdes geometry or the spacing score.
const directionKeys = ['xMinus', 'xPlus', 'yMinus', 'yPlus'];
const boundsKeys = ['minX', 'minY', 'maxX', 'maxY'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function object(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_ASSEMBLY_OBJECT ' + name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error('UNKNOWN_ASSEMBLY_FIELD ' + name + '.' + key);
}
function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw Error('INVALID_ASSEMBLY_STRING ' + name);
  return value;
}
function finite(value, name) {
  if (!Number.isFinite(value)) throw Error('INVALID_ASSEMBLY_NUMBER ' + name);
  return value;
}
function bounds(value, name) {
  object(value, boundsKeys, name);
  const b = Object.fromEntries(boundsKeys.map(k => [k, finite(value[k], name + '.' + k)]));
  if (b.maxX < b.minX || b.maxY < b.minY) throw Error('INVALID_ASSEMBLY_BOX ' + name);
  return b;
}
function rotation(value, name) {
  finite(value, name);
  const quarter = Math.round(value / 90);
  if (Math.abs(value - quarter * 90) > 1e-7) throw Error('ASSEMBLY_QUARTER_TURN_REQUIRED ' + name);
  return ((quarter % 4) + 4) % 4 * 90;
}
function margin(value, name) {
  const raw = typeof value === 'number' ? Object.fromEntries(directionKeys.map(k => [k, value])) : value;
  object(raw, directionKeys, name);
  return Object.fromEntries(directionKeys.map(k => {
    const n = finite(raw[k], name + '.' + k);
    if (n < 0) throw Error('NEGATIVE_ASSEMBLY_MARGIN ' + name + '.' + k);
    return [k, n / 0.0254];
  }));
}
function shapeRule(value, name) {
  if (own(value, 'marginMm') === own(value, 'courtyard')) throw Error('ASSEMBLY_RULE_REQUIRES_ONE_GEOMETRY ' + name);
  if (own(value, 'marginMm')) return { marginMil: margin(value.marginMm, name + '.marginMm'), courtyardLocal: null };
  const courtyard = value.courtyard;
  object(courtyard, ['coordinateSystem', 'boxMil', 'trusted', 'basis'], name + '.courtyard');
  if (courtyard.coordinateSystem !== 'component-local-zero') throw Error('INVALID_ASSEMBLY_COORDINATES ' + name);
  if (courtyard.trusted !== true) throw Error('ASSEMBLY_COURTYARD_MUST_BE_TRUSTED ' + name);
  string(courtyard.basis, name + '.courtyard.basis');
  return { marginMil: null, courtyardLocal: bounds(courtyard.boxMil, name + '.courtyard.boxMil'), courtyardBasis: courtyard.basis };
}
function unique(values, field, name) {
  const seen = new Set();
  for (const value of values) {
    string(value[field], name + '.' + field);
    if (seen.has(value[field])) throw Error('DUPLICATE_ASSEMBLY_' + name.toUpperCase() + ' ' + value[field]);
    seen.add(value[field]);
  }
}

export function compileAssemblyPolicy(snapshot, input) {
  if (input === undefined || input === null) return null;
  object(input, ['schemaVersion', 'description', 'profile', 'source', 'rules', 'overrides', 'independentPads'], 'config');
  if (input.schemaVersion !== 1) throw Error('UNSUPPORTED_ASSEMBLY_SCHEMA');
  if (input.description !== undefined) string(input.description, 'description');
  object(input.profile, ['id', 'label', 'basis'], 'profile');
  string(input.profile.id, 'profile.id'); string(input.profile.label, 'profile.label');
  if (input.profile.basis !== undefined) string(input.profile.basis, 'profile.basis');
  object(input.source, ['title', 'url', 'checkedOn'], 'source');
  string(input.source.title, 'source.title'); string(input.source.url, 'source.url');
  if (input.source.checkedOn !== undefined) string(input.source.checkedOn, 'source.checkedOn');
  if (!Array.isArray(input.rules) || !Array.isArray(input.overrides ?? [])) throw Error('INVALID_ASSEMBLY_RULE_ARRAY');
  object(input.independentPads, ['marginMm', 'basis'], 'independentPads');
  if (input.independentPads.marginMm !== 0) throw Error('ASSEMBLY_TESTPAD_MARGIN_MUST_BE_ZERO');
  string(input.independentPads.basis, 'independentPads.basis');
  if (!snapshot || !Array.isArray(snapshot.components) || !Array.isArray(snapshot.pads)) throw Error('INVALID_ASSEMBLY_SNAPSHOT');
  const rules = input.rules.map(r => {
    object(r, ['id', 'label', 'footprintNames', 'marginMm', 'courtyard', 'basis'], 'rule');
    string(r.id, 'rule.id');
    if (r.label !== undefined) string(r.label, r.id + '.label');
    if (r.basis !== undefined) string(r.basis, r.id + '.basis');
    if (!Array.isArray(r.footprintNames) || !r.footprintNames.length) throw Error('MISSING_ASSEMBLY_FOOTPRINT_NAMES ' + r.id);
    return { ...r, ...shapeRule(r, r.id) };
  });
  unique(rules, 'id', 'rule');
  const byFootprint = new Map();
  for (const r of rules) for (const name of r.footprintNames) {
    string(name, r.id + '.footprintNames');
    if (byFootprint.has(name)) throw Error('DUPLICATE_ASSEMBLY_FOOTPRINT ' + name);
    byFootprint.set(name, r);
  }
  const overrides = (input.overrides ?? []).map(o => {
    object(o, ['ref', 'marginMm', 'courtyard', 'basis'], 'override');
    string(o.ref, 'override.ref'); string(o.basis, 'override.basis');
    return { ...o, ...shapeRule(o, 'override.' + o.ref) };
  });
  unique(overrides, 'ref', 'override');
  const byOverride = new Map(overrides.map(o => [o.ref, o]));
  const components = snapshot.components.map(c => ({
    id: string(c.id, 'component.id'), ref: string(c.ref, 'component.ref'),
    footprint: string(c.footprint?.name, c.ref + '.footprint.name'),
    original: { x: finite(c.x, c.ref + '.x'), y: finite(c.y, c.ref + '.y'), rotation: rotation(c.rotation, c.ref + '.rotation') },
    componentBox: bounds(c.bbox ?? c.body, c.ref + '.bbox'), layer: c.layer ?? null
  }));
  unique(components, 'id', 'component'); unique(components, 'ref', 'component');
  const byRef = new Map(components.map(c => [c.ref, c]));
  for (const ref of byOverride.keys()) if (!byRef.has(ref)) throw Error('UNKNOWN_ASSEMBLY_OVERRIDE_REF ' + ref);
  const pads = snapshot.pads.map(p => {
    const id = string(p.id, 'pad.id');
    const owner = p.owner === undefined ? padOwner(p, components)?.ref ?? null : p.owner;
    if (owner !== null && !byRef.has(owner)) throw Error('UNKNOWN_ASSEMBLY_PAD_OWNER ' + id);
    const number = string(String(p.number ?? ''), id + '.number');
    return { id, owner, ref: owner ?? number, number, x: finite(p.x, id + '.x'), y: finite(p.y, id + '.y'), bbox: bounds(p.bbox, id + '.bbox'), layer: p.layer ?? null };
  });
  unique(pads, 'id', 'pad');
  const free = pads.filter(p => p.owner === null);
  unique([...components, ...free], 'ref', 'object');
  const records = components.map(c => {
    const base = byFootprint.get(c.footprint);
    if (!base) throw Error('UNKNOWN_ASSEMBLY_FOOTPRINT ' + c.ref + ':' + c.footprint);
    const override = byOverride.get(c.ref), selected = override ?? base;
    const allBoxes = [c.componentBox, ...pads.filter(p => p.owner === c.ref).map(p => p.bbox)];
    const physicalBox = { minX: Math.min(...allBoxes.map(b => b.minX)), minY: Math.min(...allBoxes.map(b => b.minY)), maxX: Math.max(...allBoxes.map(b => b.maxX)), maxY: Math.max(...allBoxes.map(b => b.maxY)) };
    return { ...c, physicalBox, marginMil: selected.marginMil, courtyardLocal: selected.courtyardLocal,
      ruleId: base.id, overrideBasis: override?.basis ?? null, courtyardBasis: selected.courtyardBasis ?? null,
      source: selected.courtyardLocal ? 'explicit-trusted-local-courtyard' : 'native-footprint-and-pad-bbox-proxy-expanded' };
  });
  const compiled = {
    schemaVersion: 1, units: 'mil', profile: { ...input.profile }, source: { ...input.source }, records, pads,
    absoluteFloorMil: 0, pairClearancesMil: [],
    coverage: {
      components: records.length, mappedComponents: records.length, uniqueFootprints: new Set(records.map(r => r.footprint)).size,
      rulesUsed: [...new Set(records.map(r => r.ruleId))].sort(), overrides: overrides.length,
      trustedCourtyards: records.filter(r => r.courtyardLocal).length,
      proxyCourtyards: records.filter(r => !r.courtyardLocal).length, independentPads: free.length, unknownFootprints: []
    },
    limitations: [
      'Native component bounding boxes plus owned pad boxes are physical-envelope proxies, not verified body outlines.',
      'Silkscreen is excluded. Margins are per-side assembly space, not full pair gaps or electrical copper clearance.',
      'All objects are checked conservatively in 2D, including opposite-side objects. Height and tool access are not modeled.',
      'Connector mating space and thermal separation require explicit additional input; these defaults do not establish either.',
      'This reference profile is not assembly-house or manufacturing approval.'
    ]
  };
  const initial = assemblyRuntime(compiled, snapshot.components, snapshot.pads);
  const undersized = initial.issues.find(i => i.code === 'ASSEMBLY_COURTYARD_UNDERSIZED');
  if (undersized) throw Error(undersized.code + ' ' + undersized.ref);
  return compiled;
}

// Keep this function self-contained: the native writer/readback serializes its
// source with .toString(), so it must not depend on module-scope helpers.
// Supplying pads selects strict supplied-geometry mode: no missing body or pad
// geometry may be replaced with a predicted box. The caller distinguishes
// transformed offline geometry from native readback; omit pads for prediction.
export function assemblyRuntime(compiled, components, pads) {
  if (compiled === undefined || compiled === null) return { valid: true, issues: [], checkedPairs: 0, physical: [], courtyards: [], coverage: null, profile: null, limitations: [] };
  const epsilon = 1e-7;
  const fail = (code, detail = '') => { throw Error(code + (detail ? ' ' + detail : '')); };
  const box = (b, name) => {
    if (!b || !['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) || b.minX > b.maxX || b.minY > b.maxY) fail('INVALID_ASSEMBLY_RUNTIME_BOX', name);
    return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
  };
  const quarter = (r, name) => {
    if (!Number.isFinite(r)) fail('INVALID_ASSEMBLY_RUNTIME_ROTATION', name);
    const q = Math.round(r / 90);
    if (Math.abs(r - q * 90) > epsilon) fail('ASSEMBLY_QUARTER_TURN_REQUIRED', name);
    return ((q % 4) + 4) % 4;
  };
  const pose = (c, name) => {
    if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y)) fail('INVALID_ASSEMBLY_RUNTIME_POSE', name);
    return { x: c.x, y: c.y, rotation: quarter(c.rotation, name) * 90 };
  };
  const rotate = (x, y, q) => [[x, y], [-y, x], [-x, -y], [y, -x]][q];
  const transform = (b, from, to) => {
    const q = quarter(to.rotation - from.rotation, 'transform');
    const points = [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]].map(([x, y]) => {
      const p = rotate(x - from.x, y - from.y, q); return [p[0] + to.x, p[1] + to.y];
    });
    return { minX: Math.min(...points.map(p => p[0])), minY: Math.min(...points.map(p => p[1])), maxX: Math.max(...points.map(p => p[0])), maxY: Math.max(...points.map(p => p[1])) };
  };
  const union = boxes => ({ minX: Math.min(...boxes.map(b => b.minX)), minY: Math.min(...boxes.map(b => b.minY)), maxX: Math.max(...boxes.map(b => b.maxX)), maxY: Math.max(...boxes.map(b => b.maxY)) });
  const contains = (a, b) => a.minX <= b.minX + epsilon && a.minY <= b.minY + epsilon && a.maxX + epsilon >= b.maxX && a.maxY + epsilon >= b.maxY;
  const actual = pads !== undefined;
  if (compiled.schemaVersion !== 1 || !Array.isArray(compiled.records) || !Array.isArray(compiled.pads)) fail('INVALID_COMPILED_ASSEMBLY_POLICY');
  if (!Array.isArray(components) || components.length !== compiled.records.length) fail('ASSEMBLY_COMPONENT_COUNT');
  const records = new Map(compiled.records.map(r => [r.ref, r]));
  const positions = new Map();
  const bodies = new Map();
  for (const c of components) {
    const r = records.get(c.ref);
    if (!r || (c.id !== undefined && c.id !== r.id)) fail('UNKNOWN_ASSEMBLY_COMPONENT', c.ref);
    if (positions.has(c.ref)) fail('DUPLICATE_ASSEMBLY_COMPONENT', c.ref);
    const p = pose(c, c.ref); positions.set(c.ref, p);
    if (actual && c.body === undefined && c.bbox === undefined) fail('MISSING_ASSEMBLY_ACTUAL_BODY', c.ref);
    bodies.set(c.ref, box(c.body ?? c.bbox ?? transform(r.componentBox, r.original, p), c.ref));
  }
  const originalPads = new Map(compiled.pads.map(p => [p.id, p]));
  let finalPads;
  if (actual) {
    if (!Array.isArray(pads) || pads.length !== compiled.pads.length) fail('ASSEMBLY_PAD_COUNT');
    const seen = new Set();
    finalPads = pads.map(p => {
      const old = originalPads.get(p.id);
      if (!old) fail('UNKNOWN_ASSEMBLY_PAD', p.id);
      if (seen.has(p.id)) fail('DUPLICATE_ASSEMBLY_PAD', p.id);
      seen.add(p.id);
      if (p.owner !== undefined && p.owner !== old.owner) fail('ASSEMBLY_PAD_OWNER_MISMATCH', p.id);
      if (p.number !== undefined && String(p.number) !== old.number) fail('ASSEMBLY_PAD_NUMBER_MISMATCH', p.id);
      return { ...old, bbox: box(p.bbox, p.id), layer: p.layer ?? old.layer };
    });
  } else {
    finalPads = compiled.pads.map(p => ({ ...p, bbox: p.owner === null ? box(p.bbox, p.id) : transform(p.bbox, records.get(p.owner).original, positions.get(p.owner)) }));
  }
  const zero = { x: 0, y: 0, rotation: 0 }, issues = [], physical = [], courtyards = [];
  for (const r of compiled.records) {
    const p = positions.get(r.ref);
    const b = union([bodies.get(r.ref), ...finalPads.filter(pad => pad.owner === r.ref).map(pad => pad.bbox)]);
    physical.push({ ref: r.ref, id: r.id, bbox: b, source: actual ? 'provided-footprint-and-pad-bbox-proxy' : 'predicted-native-footprint-and-pad-bbox-proxy', layer: r.layer });
    let courtyard;
    if (r.courtyardLocal) courtyard = transform(box(r.courtyardLocal, r.ref + '.courtyard'), zero, p);
    else {
      const local = transform(b, p, zero), m = r.marginMil;
      if (!m || !['xMinus', 'xPlus', 'yMinus', 'yPlus'].every(k => Number.isFinite(m[k]) && m[k] >= 0)) fail('INVALID_COMPILED_ASSEMBLY_MARGIN', r.ref);
      courtyard = transform({ minX: local.minX - m.xMinus, maxX: local.maxX + m.xPlus, minY: local.minY - m.yMinus, maxY: local.maxY + m.yPlus }, zero, p);
    }
    if (!contains(courtyard, b)) issues.push({ code: 'ASSEMBLY_COURTYARD_UNDERSIZED', ref: r.ref, physical: b, courtyard });
    courtyards.push({ ref: r.ref, id: r.id, bbox: courtyard, source: r.source, ruleId: r.ruleId, layer: r.layer });
  }
  for (const p of finalPads.filter(p => p.owner === null)) {
    physical.push({ ref: p.ref, id: p.id, bbox: { ...p.bbox }, source: actual ? 'provided-standalone-pad' : 'native-standalone-pad', layer: p.layer });
    courtyards.push({ ref: p.ref, id: p.id, bbox: { ...p.bbox }, source: 'independent-pad-zero-assembly-margin', ruleId: null, layer: p.layer });
  }
  const floor = compiled.absoluteFloorMil ?? 0;
  if (!Number.isFinite(floor) || floor < 0) fail('INVALID_ASSEMBLY_ABSOLUTE_FLOOR');
  const pairRules = compiled.pairClearancesMil ?? [];
  if (!Array.isArray(pairRules)) fail('INVALID_ASSEMBLY_PAIR_CLEARANCES');
  const pairKey = (a, b) => JSON.stringify([a, b].sort());
  const physicalByRef = new Map(physical.map(p => [p.ref, p.bbox]));
  const pairMinima = new Map();
  for (const pair of pairRules) {
    if (!pair || Object.keys(pair).some(k => !['a', 'b', 'hardMinMil'].includes(k)) || !physicalByRef.has(pair.a) || !physicalByRef.has(pair.b) || pair.a === pair.b || !Number.isFinite(pair.hardMinMil) || pair.hardMinMil < 0) fail('INVALID_ASSEMBLY_PAIR_CLEARANCE');
    const key = pairKey(pair.a, pair.b);
    if (pairMinima.has(key)) fail('DUPLICATE_ASSEMBLY_PAIR_CLEARANCE', key);
    pairMinima.set(key, pair.hardMinMil);
  }
  let checkedPairs = 0;
  for (let i = 0; i < courtyards.length; i++) for (let j = i + 1; j < courtyards.length; j++) {
    checkedPairs++;
    const a = courtyards[i], b = courtyards[j];
    const overlapX = Math.min(a.bbox.maxX, b.bbox.maxX) - Math.max(a.bbox.minX, b.bbox.minX);
    const overlapY = Math.min(a.bbox.maxY, b.bbox.maxY) - Math.max(a.bbox.minY, b.bbox.minY);
    if (overlapX > epsilon && overlapY > epsilon) issues.push({ code: 'ASSEMBLY_COURTYARD_OVERLAP', a: a.ref, b: b.ref, overlapXMil: overlapX, overlapYMil: overlapY });
    const pa = physicalByRef.get(a.ref), pb = physicalByRef.get(b.ref);
    const physicalGaps = [pb.minX - pa.maxX, pa.minX - pb.maxX, pb.minY - pa.maxY, pa.minY - pb.maxY];
    const courtyardGaps = [b.bbox.minX - a.bbox.maxX, a.bbox.minX - b.bbox.maxX, b.bbox.minY - a.bbox.maxY, a.bbox.minY - b.bbox.maxY];
    const gapMil = Math.max(...physicalGaps);
    const hardMinMil = Math.max(floor, pairMinima.get(pairKey(a.ref, b.ref)) ?? 0);
    if (gapMil + epsilon < hardMinMil) issues.push({ code: 'ASSEMBLY_PHYSICAL_CLEARANCE', a: a.ref, b: b.ref, gapMil, hardMinMil });
    // A direction must satisfy both requirements. Choosing an X separation for
    // the courtyard and a Y separation for the physical floor would disagree
    // with the directional ratio model and could incorrectly admit a candidate.
    const sharedAxis = physicalGaps.some((gap, axis) => gap + epsilon >= hardMinMil && courtyardGaps[axis] >= -epsilon);
    if (!sharedAxis && gapMil + epsilon >= hardMinMil && Math.max(...courtyardGaps) >= -epsilon) issues.push({ code: 'ASSEMBLY_DIRECTIONAL_CLEARANCE', a: a.ref, b: b.ref, hardMinMil, physicalGapsMil: physicalGaps, courtyardGapsMil: courtyardGaps });
  }
  return { valid: issues.length === 0, issues, checkedPairs, physical, courtyards, coverage: compiled.coverage, profile: compiled.profile, source: compiled.source, limitations: compiled.limitations };
}

export function buildAssemblyGeometry(compiled, components, pads) { return assemblyRuntime(compiled, components, pads); }
export function evaluateAssemblyPolicy(compiled, components, pads) { return assemblyRuntime(compiled, components, pads); }
import { padOwner } from './pcb-layout-geometry.mjs';
