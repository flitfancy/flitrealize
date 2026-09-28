import { transformPoint } from './pcb-layout-geometry.mjs';
import { layoutRealization } from './pcb-layout-provider.mjs';

const relationKinds = new Set(['power-path', 'sense', 'signal', 'reference']);
const unique = values => [...new Set(values)];
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const fail = (code, context) => { throw Error(`BLOCK_COUPLING_${code}${context ? ' ' + context : ''}`); };
const padCoordinates = pad => {
  if (pad.bbox !== undefined && pad.bbox !== null) {
    const b = pad.bbox;
    if (!['minX', 'maxX', 'minY', 'maxY'].every(key => Number.isFinite(b[key])) || b.minX > b.maxX || b.minY > b.maxY) return null;
    const x = b.minX / 2 + b.maxX / 2, y = b.minY / 2 + b.maxY / 2;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, coordinateSource: 'pad-bbox-center' } : null;
  }
  return finitePoint(pad) ? { x: pad.x, y: pad.y, coordinateSource: 'pad-x-y' } : null;
};
const checkFields = (value, fields, context) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT_OBJECT', context);
  for (const field of Object.keys(value)) if (!fields.includes(field)) fail('UNKNOWN_FIELD', `${context}.${field}`);
};
const bounds = points => points.length ? {
  minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
  minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y))
} : null;
const span = box => box ? box.maxX - box.minX + box.maxY - box.minY : null;

/** Compile topology and explicitly declared relations. Shared nets remain hyperedges;
 * they do not imply pairwise attraction, current direction, or an objective weight.
 * All returned data are serializable and independent of EDA APIs. */
export function compileBlockCoupling(contract, snapshot, input = {}, realization = layoutRealization(snapshot, contract)) {
  checkFields(input, ['schemaVersion', 'description', 'relations'], 'config');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail('SCHEMA_VERSION');
  if (input.description !== undefined && typeof input.description !== 'string') fail('INVALID_DESCRIPTION');
  if (input.relations !== undefined && !Array.isArray(input.relations)) fail('INVALID_RELATIONS');
  const components = new Map();
  for (const component of contract.components ?? []) {
    if (!component.designator || components.has(component.designator)) fail('DUPLICATE_COMPONENT', component.designator);
    components.set(component.designator, component);
  }
  const native = new Map();
  const nativeIds = new Set();
  for (const component of snapshot.components ?? []) {
    if (!component.ref || !component.id || native.has(component.ref) || nativeIds.has(component.id)) fail('DUPLICATE_NATIVE_COMPONENT', component.ref);
    if (!finitePoint(component) || !Number.isFinite(component.rotation)) fail('INVALID_NATIVE_COMPONENT', component.ref);
    native.set(component.ref, component); nativeIds.add(component.id);
  }
  const membership = new Map(), blockIds = new Set();
  const blocks = (contract.blocks ?? []).map(block => {
    if (!block.id || blockIds.has(block.id) || !Array.isArray(block.components)) fail('INVALID_BLOCK', block.id);
    blockIds.add(block.id);
    for (const ref of block.components) {
      if (!components.has(ref)) fail('UNKNOWN_BLOCK_COMPONENT', ref);
      if (membership.has(ref)) fail('DUPLICATE_PRIMARY_MEMBERSHIP', ref);
      membership.set(ref, block.id);
    }
    return { id: block.id, purpose: block.purpose ?? '', components: [...block.components] };
  });
  const ids = new Set();
  const nativeComponents = [...native.values()];
  const pads = (snapshot.pads ?? []).map(pad => {
    if (!pad.id || ids.has(pad.id)) fail('DUPLICATE_PAD', pad.id);
    const point = padCoordinates(pad);
    if (!point) fail('INVALID_PAD_POSITION', pad.id);
    ids.add(pad.id);
    const owner = padOwner(pad, nativeComponents);
    const ref = owner?.ref ?? String(pad.number);
    return {
      id: pad.id, ref, owner: owner?.ref ?? null, number: String(pad.number), net: pad.net,
      ...point, blockId: membership.get(ref) ?? null,
      basePlacement: owner ? { x: owner.x, y: owner.y, rotation: owner.rotation } : null
    };
  });
  const physicalByRef = new Map();
  for (const pad of pads) {
    if (!physicalByRef.has(pad.ref)) physicalByRef.set(pad.ref, []);
    physicalByRef.get(pad.ref).push(pad);
  }
  const nets = new Map(), logicalEndpoints = new Map(), padContractNets = new Map();
  const resolve = (ref, pin, net) => {
    const component = components.get(ref), physical = physicalByRef.get(ref);
    if (!component || !physical?.length) fail('UNKNOWN_ENDPOINT', `${ref}.${pin}/${net}`);
    if (Array.isArray(component.pins) && !component.pins.some(p => String(p.number) === pin)) fail('UNKNOWN_PIN', `${ref}.${pin}`);
    let selected;
    if (native.has(ref)) {
      const binding = realization.pinMaps[ref];
      const numbers = binding?.[pin] ?? [pin];
      if (!Array.isArray(numbers) || !numbers.length || numbers.some(number => number === null || number === undefined || String(number) === '')) fail('INVALID_PIN_MAP', `${ref}.${pin}`);
      const pins = unique(numbers.map(String));
      selected = physical.filter(p => pins.includes(p.number));
      if (pins.some(number => !selected.some(p => p.number === number))) fail('MISSING_PHYSICAL_PIN', `${ref}.${pin}`);
    } else {
      // Native test pads have number=TPxx, not number=1. Their logical pin must
      // still be declared by the Contract; arbitrary standalone copper is not a TP.
      if (component.pins?.length !== 1 || String(component.pins[0].number) !== pin || physical.length !== 1) fail('INVALID_STANDALONE_ENDPOINT', `${ref}.${pin}`);
      selected = physical;
    }
    if (selected.some(p => p.net !== net)) fail('PIN_NET_MISMATCH', `${ref}.${pin}/${net}`);
    return { ref, pin, blockId: membership.get(ref) ?? null, padIds: selected.map(p => p.id) };
  };
  for (const net of contract.nets ?? []) {
    if (!net.name || nets.has(net.name) || !Array.isArray(net.endpoints)) fail('INVALID_NET', net.name);
    const endpoints = [], endpointIds = new Set();
    for (const endpoint of net.endpoints) {
      const ref = endpoint.component, pin = String(endpoint.pin), key = `${ref}\0${pin}`;
      if (endpointIds.has(key)) fail('DUPLICATE_LOGICAL_ENDPOINT', `${ref}.${pin}/${net.name}`);
      if (logicalEndpoints.has(key)) fail('CONFLICTING_LOGICAL_NET', `${ref}.${pin}`);
      endpointIds.add(key);
      const resolved = resolve(ref, pin, net.name);
      for (const id of resolved.padIds) {
        if (padContractNets.has(id) && padContractNets.get(id) !== net.name) fail('CONFLICTING_PHYSICAL_NET', id);
        padContractNets.set(id, net.name);
      }
      endpoints.push(resolved); logicalEndpoints.set(key, { ...resolved, net: net.name });
    }
    nets.set(net.name, { name: net.name, kind: net.kind ?? 'unspecified', endpoints });
  }
  const ports = [], crossBlockNets = [];
  for (const net of nets.values()) {
    const participatingBlocks = unique(net.endpoints.map(e => e.blockId).filter(Boolean));
    if (participatingBlocks.length < 2) continue;
    const portIds = [];
    for (const blockId of participatingBlocks) {
      const endpoints = net.endpoints.filter(e => e.blockId === blockId);
      const id = `${encodeURIComponent(blockId)}:${encodeURIComponent(net.name)}`;
      ports.push({ id, blockId, net: net.name, kind: net.kind, direction: 'unspecified', endpoints, padIds: unique(endpoints.flatMap(e => e.padIds)) });
      portIds.push(id);
    }
    crossBlockNets.push({ net: net.name, kind: net.kind, blocks: participatingBlocks, portIds, padIds: unique(net.endpoints.flatMap(e => e.padIds)), endpoints: net.endpoints });
  }
  const relationIds = new Set();
  const relations = (input.relations ?? []).map(relation => {
    checkFields(relation, ['id', 'kind', 'from', 'to', 'net', 'basis', 'maxDistanceMil'], 'relation');
    if (typeof relation.id !== 'string' || !relation.id || relationIds.has(relation.id)) fail('DUPLICATE_RELATION', relation.id);
    relationIds.add(relation.id);
    if (!relationKinds.has(relation.kind)) fail('INVALID_RELATION_KIND', relation.id);
    if (!nets.has(relation.net)) fail('UNKNOWN_RELATION_NET', relation.id);
    if (relation.maxDistanceMil !== undefined && (!Number.isFinite(relation.maxDistanceMil) || relation.maxDistanceMil < 0)) fail('INVALID_DISTANCE_LIMIT', relation.id);
    const endpoints = ['from', 'to'].map(side => {
      const e = relation[side];
      checkFields(e, ['ref', 'pin'], `${relation.id}.${side}`);
      if (typeof e.ref !== 'string' || !e.ref || !['string', 'number'].includes(typeof e.pin) || e.pin === '' || (typeof e.pin === 'number' && !Number.isFinite(e.pin))) fail('INVALID_RELATION_ENDPOINT', `${relation.id}/${side}`);
      const resolved = logicalEndpoints.get(`${e.ref}\0${String(e.pin)}`);
      if (!resolved) fail('UNKNOWN_RELATION_ENDPOINT', `${e.ref}.${e.pin}`);
      if (resolved.net !== relation.net) fail('PIN_NET_MISMATCH', `${e.ref}.${e.pin}/${relation.net}`);
      return { ref: resolved.ref, pin: resolved.pin, blockId: resolved.blockId, padIds: [...resolved.padIds] };
    });
    const [from, to] = endpoints;
    return { id: relation.id, kind: relation.kind, from, to, net: relation.net,
      fromBlock: from.blockId, toBlock: to.blockId,
      crossBlock: Boolean(from.blockId && to.blockId && from.blockId !== to.blockId),
      ...(relation.maxDistanceMil === undefined ? {} : { maxDistanceMil: relation.maxDistanceMil }),
      basis: relation.basis ?? null };
  });
  return { schemaVersion: 1, blocks, ports, crossBlockNets, relations, pads,
    unassignedRefs: unique(pads.filter(p => !p.blockId).map(p => p.ref)) };
}

/** Evaluate topology and explicit distance limits, never a layout-quality score.
 * Distances are pad bounding-box-centre Manhattan proxies, not routed length or
 * electrical proof. Bounding boxes preserve precision lost by native X/Y getters.
 * Older inputs without a bounding box use X/Y and identify that fallback source.
 * When actualPads is supplied it must contain every compiled pad exactly once;
 * a missing or invalid readback point is reported and is never predicted. */
export function evaluateBlockCoupling(compiled, placements, actualPads = undefined) {
  const issues = [], positions = new Map(), points = new Map();
  for (const p of placements) {
    if (positions.has(p.ref)) issues.push({ code: 'BLOCK_COUPLING_DUPLICATE_PLACEMENT', ref: p.ref });
    positions.set(p.ref, p);
  }
  if (actualPads !== undefined) {
    if (!Array.isArray(actualPads)) throw Error('BLOCK_COUPLING_INVALID_ACTUAL_PADS');
    const expected = new Map(compiled.pads.map(p => [p.id, p])), seen = new Set();
    for (const actual of actualPads) {
      const old = expected.get(actual.id);
      if (seen.has(actual.id)) { issues.push({ code: 'BLOCK_COUPLING_DUPLICATE_ACTUAL_PAD', id: actual.id }); points.delete(actual.id); continue; }
      seen.add(actual.id);
      if (!old) { issues.push({ code: 'BLOCK_COUPLING_UNKNOWN_ACTUAL_PAD', id: actual.id }); continue; }
      const point = padCoordinates(actual);
      if (!point || String(actual.number) !== old.number || actual.net !== old.net) {
        issues.push({ code: 'BLOCK_COUPLING_INVALID_ACTUAL_PAD', id: actual.id }); continue;
      }
      points.set(actual.id, { id: old.id, ref: old.ref, number: old.number, net: old.net, ...point });
    }
    for (const old of compiled.pads) if (!seen.has(old.id)) issues.push({ code: 'BLOCK_COUPLING_MISSING_ACTUAL_PAD', id: old.id });
  } else {
    for (const pad of compiled.pads) {
      const placement = pad.owner ? positions.get(pad.owner) : positions.get(pad.ref);
      if (pad.owner && (!finitePoint(placement) || !Number.isFinite(placement.rotation))) {
        issues.push({ code: 'BLOCK_COUPLING_MISSING_PLACEMENT', ref: pad.owner, id: pad.id }); continue;
      }
      const p = pad.owner ? transformPoint(pad, pad.basePlacement, placement) : placement ? padCoordinates(placement) : pad;
      if (!finitePoint(p)) { issues.push({ code: 'BLOCK_COUPLING_INVALID_PLACEMENT', ref: pad.ref }); continue; }
      points.set(pad.id, { id: pad.id, ref: pad.ref, number: pad.number, net: pad.net, x: p.x, y: p.y, coordinateSource: pad.owner ? pad.coordinateSource : p.coordinateSource });
    }
  }
  const withCoordinates = topology => {
    const coordinates = topology.padIds.map(id => points.get(id)).filter(Boolean);
    const complete = coordinates.length === topology.padIds.length;
    const bbox = complete ? bounds(coordinates) : null;
    return { ...topology, coordinates, complete, bbox, hpwlMil: span(bbox) };
  };
  const relations = compiled.relations.map(relation => {
    const left = relation.from.padIds.map(id => points.get(id)), right = relation.to.padIds.map(id => points.get(id));
    let distanceMil = null, endpoints = null;
    if (left.every(Boolean) && right.every(Boolean)) for (const a of left) for (const b of right) {
      const distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (distanceMil === null || distance < distanceMil) { distanceMil = distance; endpoints = [a, b]; }
    }
    const limited = relation.maxDistanceMil !== undefined;
    const satisfied = !limited || distanceMil === null ? null : distanceMil <= relation.maxDistanceMil + .001;
    if (satisfied === false) issues.push({ code: 'BLOCK_COUPLING_DISTANCE_LIMIT', id: relation.id, distanceMil, maxDistanceMil: relation.maxDistanceMil });
    return { ...relation, metric: 'pad-manhattan', distanceMil, endpoints,
      measurement: { units: 'mil', metric: 'pad-manhattan', endpointSources: (endpoints ?? []).map(p => ({ padId: p.id, source: p.coordinateSource })) },
      satisfied, status: distanceMil === null ? 'unmeasured' : limited ? satisfied ? 'passed' : 'failed' : 'observed' };
  });
  return { ports: compiled.ports.map(withCoordinates), crossBlockNets: compiled.crossBlockNets.map(withCoordinates), relations, issues,
    measurement: { units: 'mil', coordinatePolicy: 'pad-bbox-center-when-present-otherwise-pad-x-y', sourcesUsed: unique([...points.values()].map(p => p.coordinateSource)), distanceMetric: 'manhattan-proxy-not-routed-length' } };
}
import { padOwner } from './pcb-layout-geometry.mjs';
