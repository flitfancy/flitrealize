import { scorePairSpacing } from './pcb-layout-spacing-policy.mjs';
import { spacingNeighbors } from './pcb-layout-uniformity.mjs';

export const clearancePairKey = (a, b) => JSON.stringify([a, b].sort());
export function assemblySpacingClearances(policy) {
  if (policy?.source !== 'assembly-courtyard') return [];
  const merged = new Map();
  for (const r of policy.requirements) {
    const key = clearancePairKey(...r.refs);
    merged.set(key, Math.max(merged.get(key) ?? 0, r.hardMinimumMil));
  }
  return [...merged].map(([key, hardMinMil]) => { const [a, b] = JSON.parse(key); return { a, b, hardMinMil }; });
}

// All objects participate in physical hard checks; only component neighbors are scored.
export function evaluateSpacingPolicy(policy, geometry, componentRefs) {
  if (!policy) return null;
  if (policy.source !== 'assembly-courtyard' || policy.geometry !== 'physical') throw Error('UNSUPPORTED_COMPILED_SPACING_POLICY');
  return evaluateAssemblySpacing(policy, geometry, componentRefs);
}

export function resolveAssemblyPairSpacing(policy, a, b, physical, courtyards) {
  const pa = physical.get(a), pb = physical.get(b), ca = courtyards.get(a), cb = courtyards.get(b);
  if (![pa, pb, ca, cb].every(Boolean)) throw Error('ASSEMBLY_SPACING_GEOMETRY_MISSING ' + a + '/' + b);
  const requirements = policy.requirements.filter(r => r.refs.includes(a) && r.refs.includes(b));
  const floor = Math.max(policy.absoluteFloorMil, ...requirements.map(r => r.hardMinimumMil));
  const mid = (lo, hi) => (lo + hi) / 2;
  const cxA = mid(pa.minX, pa.maxX), cxB = mid(pb.minX, pb.maxX), cyA = mid(pa.minY, pa.maxY), cyB = mid(pb.minY, pb.maxY);
  // The direction used for scoring is also a valid direction for separation.
  // A large raw X gap must not hide a still larger X-side courtyard margin.
  const choices = [
    { axis: 'x+', distanceMil: pb.minX - pa.maxX, marginMil: ca.maxX - pa.maxX + pb.minX - cb.minX, direction: { x: 1, y: 0 }, from: { x: pa.maxX, y: cyA }, to: { x: pb.minX, y: cyA } },
    { axis: 'x-', distanceMil: pa.minX - pb.maxX, marginMil: pa.minX - ca.minX + cb.maxX - pb.maxX, direction: { x: -1, y: 0 }, from: { x: pa.minX, y: cyA }, to: { x: pb.maxX, y: cyA } },
    { axis: 'y+', distanceMil: pb.minY - pa.maxY, marginMil: ca.maxY - pa.maxY + pb.minY - cb.minY, direction: { x: 0, y: 1 }, from: { x: cxA, y: pa.maxY }, to: { x: cxA, y: pb.minY } },
    { axis: 'y-', distanceMil: pa.minY - pb.maxY, marginMil: pa.minY - ca.minY + cb.maxY - pb.maxY, direction: { x: 0, y: -1 }, from: { x: cxA, y: pa.minY }, to: { x: cxA, y: pb.maxY } },
  ].map(c => {
    const hardMinMil = Math.max(floor, c.marginMil), baselineMil = hardMinMil / policy.bandRatios.rejectBelow;
    if (![hardMinMil, baselineMil, baselineMil * policy.bandRatios.neutralMax].every(Number.isFinite)) throw Error('INVALID_ASSEMBLY_SPACING_DERIVED_LIMIT');
    return { ...c, hardMinMil, baselineMil, fit: c.distanceMil / hardMinMil };
  });
  choices.sort((x, y) => y.fit - x.fit);
  const chosen = choices[0];
  return { a, b, geometry: 'physical', metric: 'directional-axis-gap', state: 'ready', ...chosen,
    neutralMinMil: chosen.baselineMil * policy.bandRatios.neutralMin, neutralMaxMil: chosen.baselineMil * policy.bandRatios.neutralMax,
    sources: [{ type: 'assembly-courtyard', hardMinimumMil: chosen.marginMil }, { type: 'absolute-floor', hardMinimumMil: policy.absoluteFloorMil }, ...requirements.map(r => ({ type: 'requirement', ...r }))] };
}

function evaluateAssemblySpacing(policy, geometry, componentRefs) {
  const assembly = geometry.assemblyPolicy;
  const physical = new Map((geometry.physical ?? []).map(s => [s.ref, s.bbox]));
  const courtyards = new Map((assembly?.courtyards ?? []).map(s => [s.ref, s.bbox]));
  const report = { mode: policy.mode, state: policy.state, source: policy.source, baselineStatus: 'derived', effective: true,
    geometry: 'physical', baselineDefinition: policy.baselineDefinition, bandRatios: policy.bandRatios,
    requirements: policy.requirements, issues: [], neighbors: [], penalty: null, stats: null };
  const absent = policy.refs.filter(ref => !physical.has(ref) || !courtyards.has(ref));
  if (absent.length) { report.issues.push({ code: 'ASSEMBLY_SPACING_GEOMETRY_MISSING', refs: absent }); return report; }
  const resolved = new Map();
  for (let i = 0; i < policy.refs.length; i++) for (let j = i + 1; j < policy.refs.length; j++) {
    const pair = resolveAssemblyPairSpacing(policy, policy.refs[i], policy.refs[j], physical, courtyards);
    resolved.set(clearancePairKey(pair.a, pair.b), pair);
    const checked = scorePairSpacing(pair.distanceMil, pair);
    if (!checked.accepted) report.issues.push({ code: 'ASSEMBLY_SPACING_HARD_LIMIT', refs: [pair.a, pair.b], ...pair, ...checked });
  }
  const penalties = new Map(componentRefs.map(ref => [ref, []]));
  for (const edge of spacingNeighbors(componentRefs.map(ref => ({ ref, bbox: physical.get(ref) })))) {
    // Resolve again only when neighbor order differs, so direction always means a -> b.
    const saved = resolved.get(clearancePairKey(edge.a, edge.b));
    const pair = saved.a === edge.a ? saved : resolveAssemblyPairSpacing(policy, edge.a, edge.b, physical, courtyards);
    const checked = scorePairSpacing(pair.distanceMil, pair);
    report.neighbors.push({ ...edge, ...pair, ...checked });
    penalties.get(edge.a).push(checked.penalty); penalties.get(edge.b).push(checked.penalty);
  }
  const means = [...penalties.values()].filter(v => v.length).map(v => v.reduce((a, b) => a + b, 0) / v.length);
  report.penalty = report.issues.length ? null : means.length ? means.reduce((a, b) => a + b, 0) / means.length : 0;
  const count = status => report.neighbors.filter(n => n.status === status).length;
  report.stats = { checkedPairs: policy.refs.length * (policy.refs.length - 1) / 2, neighborPairs: report.neighbors.length,
    belowMinimum: count('below-minimum'), tight: count('tight'), neutral: count('neutral'), loose: count('loose'),
    neutralFraction: report.neighbors.length ? count('neutral') / report.neighbors.length : null };
  return report;
}
