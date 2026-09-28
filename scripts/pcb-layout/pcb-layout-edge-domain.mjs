// Edge-constrained parts are parameterized by a legal side/rotation and an
// along-edge coordinate. Their normal coordinate is derived, never searched.
// Side names follow native EDA coordinates: top=minY, bottom=maxY.
import { angle, transformBox } from './pcb-layout-geometry.mjs';
import { availableEdges } from './pcb-layout-edge.mjs';

const sideGeometry = {
  left: { normalAxis: 'x', tangentAxis: 'y', normalKey: 'minX', normalSign: -1 },
  right: { normalAxis: 'x', tangentAxis: 'y', normalKey: 'maxX', normalSign: 1 },
  top: { normalAxis: 'y', tangentAxis: 'x', normalKey: 'minY', normalSign: -1 },
  bottom: { normalAxis: 'y', tangentAxis: 'x', normalKey: 'maxY', normalSign: 1 }
};
const boxKeys = ['minX', 'maxX', 'minY', 'maxY'];
const epsilon = 1e-7;
const axisKeys = axis => axis === 'x' ? ['minX', 'maxX'] : ['minY', 'maxY'];

function quarter(rotation, ref) {
  if (!Number.isFinite(rotation)) throw Error('EDGE_DOMAIN_INVALID_ROTATION ' + ref);
  const normalized = angle(rotation), snapped = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - snapped) > epsilon) throw Error('EDGE_DOMAIN_INVALID_ROTATION ' + ref);
  return angle(snapped);
}

function validBox(box) {
  return box && boxKeys.every(key => Number.isFinite(box[key])) && box.maxX > box.minX && box.maxY > box.minY;
}

/** Compile intersections of static edge and rotation requirements once.
 * Empty intersections remain inspectable instead of preventing model loading.
 * Geometry is canonicalized for calculation; fixed metadata is preserved.
 */
export function compileEdgeDomains(edgeRules, components, allowedRotations, fixed = new Map()) {
  if (!Array.isArray(edgeRules) || !(components instanceof Map) || !(allowedRotations instanceof Map) || !(fixed instanceof Map)) throw Error('INVALID_EDGE_DOMAIN_INPUT');
  const domains = new Map();
  for (const rule of edgeRules) {
    const component = components.get(rule.ref), rotations = allowedRotations.get(rule.ref);
    if (domains.has(rule.ref) || !component || !validBox(component.bbox) || !Number.isFinite(component.x) || !Number.isFinite(component.y) || !Array.isArray(rotations)) throw Error('INVALID_EDGE_DOMAIN_COMPONENT ' + rule.ref);
    const sourceRotation = quarter(component.rotation, rule.ref);
    const allowed = [...new Set(rotations.map(rotation => quarter(rotation, rule.ref)))].sort((a, b) => a - b);
    const isFixed = fixed.has(rule.ref);
    if (isFixed) {
      const target = fixed.get(rule.ref);
      if (!target || ['x', 'y', 'rotation'].some(key => target[key] !== component[key])) throw Error('EDGE_DOMAIN_FIXED_POSITION_MISMATCH ' + rule.ref);
    }
    const fixedPose = isFixed ? Object.freeze({ ref: rule.ref, x: component.x, y: component.y, rotation: component.rotation }) : undefined;
    const states = [];
    for (const rotation of allowed) {
      if (isFixed && rotation !== sourceRotation) continue;
      const bodyOffset = Object.freeze(transformBox(component.bbox, { ...component, rotation: sourceRotation }, { x: 0, y: 0, rotation }));
      for (const side of availableEdges(rule, rotation)) {
        if (!sideGeometry[side]) throw Error('INVALID_EDGE_DOMAIN_SIDE ' + rule.ref);
        const metadataRotation = isFixed ? component.rotation : rotation;
        states.push(Object.freeze({ id: side + ':' + metadataRotation, side, rotation: metadataRotation, bodyOffset, ...sideGeometry[side] }));
      }
    }
    const maxInsetMil = rule.maxInsetMil ?? 0;
    if (!Number.isFinite(maxInsetMil) || maxInsetMil < 0) throw Error('INVALID_EDGE_DOMAIN_INSET ' + rule.ref);
    domains.set(rule.ref, Object.freeze({ ref: rule.ref, rule, maxInsetMil, fixed: isFixed, ...(fixedPose ? { fixedPose } : {}), states: Object.freeze(states), status: states.length ? 'ready' : 'unsatisfied', ...(!states.length ? { issue: { code: 'EDGE_DOMAIN_EMPTY', ref: rule.ref } } : {}) }));
  }
  return domains;
}

/** Decode an already legal state inside the current (not fixed-board) extent.
 * alongMil is the absolute tangential origin coordinate and is clamped to the
 * feasible interval. null means this state cannot fit this extent/anchor limit.
 * Fixed parts are checked at their exact original pose and never repositioned.
 */
export function decodeEdgePose(domain, state, envelope, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['alongMil','insetMil','anchorCenter','maxDistanceMil'].includes(k))) throw Error('EDGE_DOMAIN_INVALID_PARAMETERS');
  if (!domain || !Array.isArray(domain.states)) throw Error('INVALID_EDGE_DOMAIN');
  const cached = state && domain.states.find(s => s === state || (s.id === state.id && s.side === state.side && s.rotation === state.rotation));
  if (!cached) throw Error('EDGE_DOMAIN_ILLEGAL_STATE ' + domain.ref);
  if (!validBox(envelope)) throw Error('EDGE_DOMAIN_INVALID_ENVELOPE ' + domain.ref);
  const { alongMil, insetMil = 0, anchorCenter, maxDistanceMil } = options;
  if ((alongMil !== undefined && !Number.isFinite(alongMil)) || !Number.isFinite(insetMil) || insetMil < 0 || insetMil > domain.maxInsetMil) throw Error('EDGE_DOMAIN_INVALID_PARAMETERS ' + domain.ref);
  const hasAnchor = anchorCenter !== undefined || maxDistanceMil !== undefined;
  if (hasAnchor && (!anchorCenter || !Number.isFinite(anchorCenter.x) || !Number.isFinite(anchorCenter.y) || !Number.isFinite(maxDistanceMil) || maxDistanceMil < 0)) throw Error('EDGE_DOMAIN_INVALID_ANCHOR ' + domain.ref);
  const { normalAxis, tangentAxis, normalKey, normalSign, bodyOffset } = cached;
  const [normalMin, normalMax] = axisKeys(normalAxis), [tangentMin, tangentMax] = axisKeys(tangentAxis);
  const normal = domain.fixed ? domain.fixedPose[normalAxis] : envelope[normalKey] - normalSign * insetMil - bodyOffset[normalKey];
  if (normal + bodyOffset[normalMin] < envelope[normalMin] - epsilon || normal + bodyOffset[normalMax] > envelope[normalMax] + epsilon) return null;
  let min = envelope[tangentMin] - bodyOffset[tangentMin], max = envelope[tangentMax] - bodyOffset[tangentMax];
  if (hasAnchor) {
    const remaining = maxDistanceMil - Math.abs(normal - anchorCenter[normalAxis]);
    if (remaining < -epsilon) return null;
    min = Math.max(min, anchorCenter[tangentAxis] - Math.max(0, remaining));
    max = Math.min(max, anchorCenter[tangentAxis] + Math.max(0, remaining));
  }
  if (min > max + epsilon) return null;
  // Arithmetic noise may close a single-point interval by a few ulps.
  if (min > max) min = max = (min + max) / 2;
  let along = domain.fixed ? domain.fixedPose[tangentAxis] : Math.min(max, Math.max(min, alongMil ?? (min + max) / 2));
  let actualInset = insetMil;
  if (domain.fixed) {
    actualInset = normalSign * (envelope[normalKey] - (normal + bodyOffset[normalKey]));
    if (along < min - epsilon || along > max + epsilon || actualInset < -epsilon || actualInset > domain.maxInsetMil + epsilon) return null;
    actualInset = Math.max(0, actualInset);
  }
  const pose = domain.fixed ? { ...domain.fixedPose } : { ref: domain.ref, x: normalAxis === 'x' ? normal : along, y: normalAxis === 'y' ? normal : along, rotation: cached.rotation };
  return { pose, parameters: { side: cached.side, rotation: cached.rotation, alongMil: along, insetMil: actualInset }, interval: { min, max } };
}
