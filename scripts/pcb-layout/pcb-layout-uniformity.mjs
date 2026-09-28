// Deterministic local spacing over component + native-designator envelopes.
// No board bounds, name heuristics, AI calls, or maximum neighbor radius.
const eps = 1e-7;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function compileUniformity(input) {
  if (input === undefined) return null;
  if (!input || Object.keys(input).some(k => !['targetMil', 'toleranceMil'].includes(k)) ||
      !Number.isFinite(input.targetMil) || !Number.isFinite(input.toleranceMil) ||
      input.targetMil <= 0 || input.toleranceMil <= 0 || input.toleranceMil >= input.targetMil) throw Error('INVALID_UNIFORMITY_OPTIONS');
  return { ...input };
}

// Gentle quadratic inside the tolerance; smooth, asymptotically linear tails.
// Retain curvature outside the band so redistributing two large gaps can help.
export function uniformityPenalty(distance, { targetMil, toleranceMil }) {
  const z = Math.abs(distance - targetMil) / toleranceMil;
  const excess = z - 1;
  return z <= 1 ? .1 * z * z : .1 + .2 * excess + Math.hypot(1, excess) - 1;
}

function closest(a, b) {
  const axis = (lo, hi, blo, bhi) => hi < blo ? [hi, blo] : bhi < lo ? [lo, bhi] : [(Math.max(lo, blo) + Math.min(hi, bhi)) / 2, (Math.max(lo, blo) + Math.min(hi, bhi)) / 2];
  const [ax, bx] = axis(a.minX, a.maxX, b.minX, b.maxX), [ay, by] = axis(a.minY, a.maxY, b.minY, b.maxY);
  return { from: { x: ax, y: ay }, to: { x: bx, y: by }, distanceMil: Math.hypot(bx - ax, by - ay) };
}

export function spacingNeighbors(bundles) {
  const nodes = [...bundles].sort((a, b) => cmp(a.ref, b.ref)), edges = new Map();
  const key = (a, b) => [a, b].sort(cmp).join('\0');
  function add(a, b, geometry, kind) {
    const id = key(a.ref, b.ref);
    if (!edges.has(id)) edges.set(id, { a: a.ref, b: b.ref, ...geometry, kind });
  }
  // Sweep rays perpendicular to each face. A nearer box hides only the interval
  // it covers; a large part can therefore have several visible small neighbors.
  for (const a of nodes) for (const [axis, sign] of [['X', -1], ['X', 1], ['Y', -1], ['Y', 1]]) {
    const other = axis === 'X' ? 'Y' : 'X', face = a.bbox[(sign > 0 ? 'max' : 'min') + axis];
    let open = [[a.bbox['min' + other], a.bbox['max' + other]]];
    const candidates = nodes.filter(b => b !== a).map(b => ({ b, distance: sign * (b.bbox[(sign > 0 ? 'min' : 'max') + axis] - face), lo: Math.max(a.bbox['min' + other], b.bbox['min' + other]), hi: Math.min(a.bbox['max' + other], b.bbox['max' + other]) }))
      .filter(c => c.distance >= -eps && c.hi - c.lo > eps).sort((a, b) => a.distance - b.distance || cmp(a.b.ref, b.b.ref));
    for (const c of candidates) {
      const visible = open.map(([lo, hi]) => [Math.max(lo, c.lo), Math.min(hi, c.hi)]).filter(([lo, hi]) => hi - lo > eps);
      if (!visible.length) continue;
      visible.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      const midpoint = (visible[0][0] + visible[0][1]) / 2;
      const from = axis === 'X' ? { x: face, y: midpoint } : { x: midpoint, y: face };
      const to = { ...from, [axis.toLowerCase()]: face + sign * c.distance };
      add(a, c.b, { from, to, distanceMil: Math.max(0, c.distance) }, 'visible');
      open = open.flatMap(([lo, hi]) => hi <= c.lo || lo >= c.hi ? [[lo, hi]] : [[lo, Math.min(hi, c.lo)], [Math.max(lo, c.hi), hi]].filter(([l, h]) => h - l > eps));
      if (!open.length) break;
    }
  }
  // Visibility through a narrow slit is not enough to make two distant parts
  // local neighbors. Drop a long edge when another envelope is closer to BOTH
  // endpoints. This is scale-free: no tunable radius or cutoff to game.
  const distances = new Map();
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) distances.set(key(nodes[i].ref, nodes[j].ref), closest(nodes[i].bbox, nodes[j].bbox).distanceMil);
  for (const [id, e] of edges) if (nodes.some(c => c.ref !== e.a && c.ref !== e.b && Math.max(distances.get(key(e.a, c.ref)), distances.get(key(e.b, c.ref))) < e.distanceMil - eps)) edges.delete(id);
  // Connect disconnected diagonal islands with the shortest envelope gaps.
  // This avoids zero-neighbor rewards and pairs of isolated, well-spaced parts.
  // Only the missing bridges are retained, not all pairwise distances.
  const parents = new Map(nodes.map(n => [n.ref, n.ref]));
  function root(r) { while (parents.get(r) !== r) r = parents.get(r); return r; }
  function join(a, b) { const ar = root(a), br = root(b); if (ar === br) return false; parents.set(ar, br); return true; }
  for (const e of edges.values()) join(e.a, e.b);
  if (new Set(nodes.map(n => root(n.ref))).size > 1) {
    const pairs = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (root(nodes[i].ref) !== root(nodes[j].ref)) pairs.push({ a: nodes[i], b: nodes[j], geometry: closest(nodes[i].bbox, nodes[j].bbox) });
    pairs.sort((a, b) => a.geometry.distanceMil - b.geometry.distanceMil || cmp(key(a.a.ref, a.b.ref), key(b.a.ref, b.b.ref)));
    for (const p of pairs) if (join(p.a.ref, p.b.ref)) add(p.a, p.b, p.geometry, 'bridge');
  }
  return [...edges.values()].sort((a, b) => cmp(key(a.a, a.b), key(b.a, b.b)));
}

export function evaluateUniformity(options, components, occupied) {
  if (!options) return null;
  const edges = spacingNeighbors(components.map(c => ({ ref: c.ref, bbox: occupied.get(c.ref) })));
  const perRef = new Map(components.map(c => [c.ref, []]));
  for (const e of edges) {
    e.penalty = uniformityPenalty(e.distanceMil, options);
    e.status = e.distanceMil < options.targetMil - options.toleranceMil ? 'tight' : e.distanceMil > options.targetMil + options.toleranceMil ? 'loose' : 'inBand';
    perRef.get(e.a).push(e.penalty); perRef.get(e.b).push(e.penalty);
  }
  const values = edges.map(e => e.distanceMil).sort((a, b) => a - b), n = values.length;
  const percentile = p => { if (!n) return null; const at = (n - 1) * p, lo = Math.floor(at); return values[lo] + (values[Math.ceil(at)] - values[lo]) * (at - lo); };
  const meanMil = n ? values.reduce((a, b) => a + b, 0) / n : null;
  const stats = { pairs: n, bridges: edges.filter(e => e.kind === 'bridge').length, meanMil, medianMil: percentile(.5), p10Mil: percentile(.1), p90Mil: percentile(.9), stddevMil: n ? Math.sqrt(values.reduce((a, b) => a + (b - meanMil) ** 2, 0) / n) : null,
    tight: edges.filter(e => e.status === 'tight').length, inBand: edges.filter(e => e.status === 'inBand').length, loose: edges.filter(e => e.status === 'loose').length };
  stats.inBandFraction = n ? stats.inBand / n : null;
  // Each component contributes equally; large parts do not dominate solely by
  // exposing more face segments. Distribution statistics are display-only.
  const penalties = [...perRef.values()].filter(v => v.length).map(v => v.reduce((a, b) => a + b, 0) / v.length);
  return { ...options, penalty: penalties.length ? penalties.reduce((a, b) => a + b, 0) / penalties.length : 0, stats, edges };
}

export function spacingTranslation(edge, ref, targetMil, stepMil, gridMil) {
  if (![edge.a, edge.b].includes(ref) || edge.distanceMil <= eps) return { dx: 0, dy: 0 };
  const error = edge.distanceMil - targetMil;
  if (Math.abs(error) < gridMil / 2) return { dx: 0, dy: 0 };
  const length = Math.min(stepMil, Math.abs(error)), sign = (ref === edge.a ? 1 : -1) * Math.sign(error);
  const snap = n => Math.round(n / gridMil) * gridMil;
  return { dx: snap(sign * length * (edge.to.x - edge.from.x) / edge.distanceMil), dy: snap(sign * length * (edge.to.y - edge.from.y) / edge.distanceMil) };
}
