// Offline, topology-driven coarse placement. These proposals are deliberately
// not labelled feasible: the existing mechanical/edge validator is authoritative.
import { angle, transformBox } from './pcb-layout-geometry.mjs';
import { availableEdges } from './pcb-layout-edge.mjs';
import { compileEdgeDomains, decodeEdgePose } from './pcb-layout-edge-domain.mjs';

const ZERO = { x: 0, y: 0, rotation: 0 };
const SIDES = ['left', 'right', 'top', 'bottom'];
const round = x => { const n = Math.round(x * 1e6) / 1e6; return Object.is(n, -0) ? 0 : n; };
const box = b => Object.fromEntries(['minX', 'maxX', 'minY', 'maxY'].map(k => [k, round(b[k])]));
const bounds = bs => ({ minX: Math.min(...bs.map(b => b.minX)), maxX: Math.max(...bs.map(b => b.maxX)), minY: Math.min(...bs.map(b => b.minY)), maxY: Math.max(...bs.map(b => b.maxY)) });
const center = b => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
const area = b => (b.maxX - b.minX) * (b.maxY - b.minY);
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const gap = (a, b) => Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY);
const sorted = values => [...values].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
const seeded = seed => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); };
const shuffled = (values, random) => { const a = [...values]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const keyPair = (a, b) => JSON.stringify(sorted([a, b]));

function localGeometry(model) {
  const assembly = new Map((model.assemblyPolicy?.records ?? []).map(r => [r.ref, r]));
  const result = new Map();
  for (const ref of sorted(model.components.keys())) {
    const c = model.components.get(ref), record = assembly.get(ref);
    const from = { x: c.x, y: c.y, rotation: Math.round(c.rotation / 90) * 90 };
    if (Math.abs(c.rotation - from.rotation) > 1e-7) throw Error('INITIAL_PROPOSAL_QUARTER_TURN_REQUIRED ' + ref);
    // Inverse-transform the physical geometry, never the relative locations of
    // other parts or the original label side. Round cancellation noise here.
    const physical = box(transformBox(record?.physicalBox ?? c.bbox, from, ZERO));
    let courtyard;
    if (record?.courtyardLocal) courtyard = box(record.courtyardLocal);
    else if (record?.marginMil) {
      const m = record.marginMil;
      courtyard = box({ minX: physical.minX - m.xMinus, maxX: physical.maxX + m.xPlus, minY: physical.minY - m.yMinus, maxY: physical.maxY + m.yPlus });
    } else courtyard = physical;
    const rotations = [...new Set((model.allowedRotations.get(ref) ?? [0, 90, 180, 270]).map(v => round(angle(v))))].sort((a, b) => a - b);
    if (!rotations.length) throw Error('INITIAL_PROPOSAL_NO_ROTATIONS ' + ref);
    result.set(ref, { ref, physical, courtyard, body: box(transformBox(c.bbox, from, ZERO)), rotations });
  }
  return result;
}

function topology(model) {
  const members = new Map(), membership = new Map();
  for (const block of [...(model.contract.blocks ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const refs = sorted(block.components ?? block.members ?? []);
    members.set(block.id, refs.filter(ref => model.components.has(ref)));
    for (const ref of refs) {
      if (membership.has(ref)) throw Error('INITIAL_PROPOSAL_DUPLICATE_BLOCK_REF ' + ref);
      membership.set(ref, block.id);
    }
  }
  const unassigned = sorted([...model.components.keys()].filter(ref => !membership.has(ref)));
  if (unassigned.length) {
    members.set('__unassigned__', unassigned);
    for (const ref of unassigned) membership.set(ref, '__unassigned__');
  }
  for (const [id, refs] of members) if (!refs.length) members.delete(id);
  const pair = new Map();
  const add = (a, b, weight) => {
    if (a === b || !model.components.has(a) || !model.components.has(b)) return;
    const key = keyPair(a, b), old = pair.get(key);
    pair.set(key, { a: sorted([a, b])[0], b: sorted([a, b])[1], weight: (old?.weight ?? 0) + weight });
  };
  // Only explicitly declared binary relations become pair attraction. A shared
  // net is kept as one hyperedge below, not expanded to O(n^2) pairs.
  const electricalGroupWeights = {};
  for (const link of model.links ?? []) {
    const weight = model.config?.comparisonWeights?.[link.group] ?? 2;
    if (!Number.isFinite(weight) || weight < 0) throw Error('INVALID_INITIAL_ELECTRICAL_WEIGHT ' + link.group);
    if (link.group !== undefined) electricalGroupWeights[link.group] = weight;
    if (weight > 0) add(link.a, link.b, weight);
  }
  for (const relation of model.couplingModel?.relations ?? []) add(relation.from.ref, relation.to.ref, 3);
  for (const group of model.spatialRules?.localGroups ?? []) {
    const anchor = group.anchor ?? sorted(group.refs)[0];
    for (const ref of group.refs) if (ref !== anchor) add(anchor, ref, 2);
  }
  for (const rule of model.blockRules ?? []) for (const anchor of rule.anchors) add(rule.ref, anchor, 3 / rule.anchors.length);
  const nets = (model.connectivity ?? []).map(n => ({ name: n.name, refs: sorted(new Set(n.pads.map(p => p.owner).filter(ref => model.components.has(ref)))) })).filter(n => n.refs.length > 1).sort((a, b) => a.name.localeCompare(b.name));
  return { members, membership, pairs: [...pair.values()].sort((a, b) => keyPair(a.a, a.b).localeCompare(keyPair(b.a, b.b))), nets,
    relationHeuristics: { electricalGroupWeights, unconfiguredElectricalWeight: 2, localGroupAnchorWeight: 2, declaredRelationWeight: 3, blockAnchorTotalWeight: 3, netHyperedgeWeight: 1,
      basis: 'Coarse initialization heuristic only, not the final candidate score. Zero electrical group weight omits that link contribution; independently declared groups and nets remain active.' } };
}

function posedBox(shape, pose, kind = 'courtyard') {
  return box(transformBox(shape[kind], ZERO, pose));
}

function candidatesAround(shape, rotation, placed, target, grid, clearance) {
  const b = posedBox(shape, { ...ZERO, rotation }), snap = n => Math.round(n / grid) * grid;
  const result = [], keys = new Set();
  const add = (x, y) => {
    const p = { ref: shape.ref, x: snap(x), y: snap(y), rotation }, k = p.x + ',' + p.y;
    if (!keys.has(k)) { keys.add(k); result.push(p); }
  };
  add(target.x - (b.minX + b.maxX) / 2, target.y - (b.minY + b.maxY) / 2);
  for (const p of placed) {
    const other = p.box, c = center(other);
    // Grid rounding is covered by the extra grid unit, so contact candidates
    // stay outside the requested coarse packing gap after quantization.
    const d = clearance + grid;
    for (const y of [c.y - (b.minY + b.maxY) / 2, other.minY - b.minY, other.maxY - b.maxY]) {
      add(other.minX - d - b.maxX, y); add(other.maxX + d - b.minX, y);
    }
    for (const x of [c.x - (b.minX + b.maxX) / 2, other.minX - b.minX, other.maxX - b.maxX]) {
      add(x, other.minY - d - b.maxY); add(x, other.maxY + d - b.minY);
    }
  }
  return result;
}

function packBlock(refs, shapes, topo, random, options, blockIndex) {
  const { grid, strength, packingGap } = options;
  const desiredAspect = Math.exp((random() - .5) * strength * 1.5);
  const refset = new Set(refs), pairs = topo.pairs.filter(p => refset.has(p.a) && refset.has(p.b));
  const nets = topo.nets.map(n => ({ ...n, refs: n.refs.filter(ref => refset.has(ref)) })).filter(n => n.refs.length > 1);
  const adjacency = new Map(refs.map(ref => [ref, []]));
  for (const p of pairs) { adjacency.get(p.a).push({ ref: p.b, weight: p.weight }); adjacency.get(p.b).push({ ref: p.a, weight: p.weight }); }
  const priorities = new Map(refs.map(ref => [ref, random()]));
  const remaining = new Set(refs), placed = [], positions = new Map();
  while (remaining.size) {
    const ranked = [...remaining].map(ref => {
      const links = adjacency.get(ref), linked = links.reduce((sum, l) => sum + (positions.has(l.ref) ? l.weight : 0), 0);
      const degree = links.reduce((sum, l) => sum + l.weight, 0) + nets.filter(n => n.refs.includes(ref)).reduce((sum, n) => sum + 1 / n.refs.length, 0);
      return { ref, rank: linked * 10 + degree + Math.sqrt(area(shapes.get(ref).courtyard)) / 100 + priorities.get(ref) * strength * 6 };
    }).sort((a, b) => b.rank - a.rank || a.ref.localeCompare(b.ref));
    const ref = ranked[0].ref, shape = shapes.get(ref), linked = adjacency.get(ref).filter(l => positions.has(l.ref));
    const linkedTotal = linked.reduce((sum, l) => sum + l.weight, 0);
    const target = linkedTotal ? linked.reduce((p, l) => ({ x: p.x + positions.get(l.ref).x * l.weight / linkedTotal, y: p.y + positions.get(l.ref).y * l.weight / linkedTotal }), { x: 0, y: 0 }) : { x: 0, y: 0 };
    const activeNets = nets.filter(n => n.refs.includes(ref));
    let best;
    for (const rotation of shape.rotations) for (const pose of candidatesAround(shape, rotation, placed, target, grid, packingGap)) {
      const bbox = posedBox(shape, pose);
      if (placed.some(p => gap(bbox, p.box) < packingGap - .001)) continue;
      const total = bounds([...placed.map(p => p.box), bbox]), width = total.maxX - total.minX, height = total.maxY - total.minY;
      let connection = linked.reduce((sum, l) => sum + l.weight * distance(pose, positions.get(l.ref)), 0) / Math.max(1, linkedTotal);
      for (const n of activeNets) {
        const others = n.refs.filter(r => positions.has(r)).map(r => positions.get(r));
        if (!others.length) continue;
        const oldSpan = Math.max(...others.map(p => p.x)) - Math.min(...others.map(p => p.x)) + Math.max(...others.map(p => p.y)) - Math.min(...others.map(p => p.y));
        const all = [...others, pose];
        const span = Math.max(...all.map(p => p.x)) - Math.min(...all.map(p => p.x)) + Math.max(...all.map(p => p.y)) - Math.min(...all.map(p => p.y));
        connection += (span - oldSpan) / Math.max(1, activeNets.length);
      }
      const compact = Math.sqrt(width * height) + .15 * (width / Math.sqrt(desiredAspect) + height * Math.sqrt(desiredAspect));
      const cost = connection + compact * .7 + random() * strength * (grid * 3 + compact * .035);
      if (!best || cost < best.cost) best = { pose, box: bbox, cost };
    }
    if (!best) throw Error('INITIAL_PROPOSAL_PACKING_FAILED ' + ref);
    placed.push({ ...best.pose, box: best.box }); positions.set(ref, best.pose); remaining.delete(ref);
  }
  const extent = bounds(placed.map(p => p.box));
  return { poses: placed.map(({ box: ignored, ...p }) => p), extent, aspect: round(desiredAspect), blockIndex };
}

function placeBlocks(order, blocks, gapMil, rowCount) {
  const rows = [];
  for (let r = 0, i = 0; r < rowCount; r++) {
    const take = Math.ceil((order.length - i) / (rowCount - r)); rows.push(order.slice(i, i + take)); i += take;
  }
  const rowsInfo = rows.map(ids => ({ ids, height: Math.max(...ids.map(id => blocks.get(id).extent.maxY - blocks.get(id).extent.minY)), width: ids.reduce((sum, id) => { const b = blocks.get(id).extent; return sum + b.maxX - b.minX; }, 0) + gapMil * (ids.length - 1) }));
  const width = Math.max(...rowsInfo.map(r => r.width)), offsets = new Map();
  let y = 0;
  for (let r = 0; r < rowsInfo.length; r++) {
    const row = rowsInfo[r]; let x = (width - row.width) / 2;
    for (const id of row.ids) {
      const b = blocks.get(id).extent, h = b.maxY - b.minY;
      // The two rows face opposite outside edges so no functional block is
      // trapped in the interior of a three-row grid.
      const localY = r === 0 ? 0 : row.height - h;
      offsets.set(id, { x: x - b.minX, y: y + localY - b.minY, row: r });
      x += b.maxX - b.minX + gapMil;
    }
    y += row.height + gapMil;
  }
  const centers = new Map([...offsets].map(([id, o]) => { const c = center(blocks.get(id).extent); return [id, { x: c.x + o.x, y: c.y + o.y }]; }));
  return { offsets, centers, width, height: y - gapMil };
}

function chooseBlockArrangement(blocks, topo, random, options) {
  const ids = sorted(blocks.keys()), rowCount = ids.length < 3 ? 1 : 2;
  const gapMil = options.packingGap * (3 + random() * options.strength * 2) + options.grid * 2;
  const trials = [ids];
  if (options.strength > 0) for (let i = 0; i < 32; i++) trials.push(shuffled(ids, random));
  let best;
  const scores = [];
  for (const order of trials) {
    const arrangement = placeBlocks(order, blocks, gapMil, rowCount);
    let sum = 0, weights = 0;
    for (const p of topo.pairs) {
      const a = topo.membership.get(p.a), b = topo.membership.get(p.b);
      if (a === b) continue;
      sum += distance(arrangement.centers.get(a), arrangement.centers.get(b)) * p.weight; weights += p.weight;
    }
    for (const net of topo.nets) {
      const blockIds = [...new Set(net.refs.map(ref => topo.membership.get(ref)))];
      if (blockIds.length < 2) continue;
      const ps = blockIds.map(id => arrangement.centers.get(id));
      sum += Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)) + Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)); weights++;
    }
    const cost = sum / Math.max(1, weights);
    scores.push({ order, arrangement, cost });
    if (!best || cost < best.cost) best = { order, arrangement, cost };
  }
  // Exploration controls how far from the best topology proxy a different
  // ordering can be selected; the final solver still evaluates every hard rule.
  const tolerance = (best.cost || Math.max(best.arrangement.width, best.arrangement.height)) * options.strength * .5;
  const eligible = scores.filter(s => s.cost <= best.cost + tolerance);
  return eligible[Math.floor(random() * eligible.length)];
}

function placeEdges(model, poses, shapes, topo, random, options) {
  const positions = new Map(poses.map(p => [p.ref, p]));
  const domains = model.edgeDomains ?? compileEdgeDomains(model.edgeRules ?? [], model.components, model.allowedRotations, model.fixed);
  const edgeRefs = new Set((model.edgeRules ?? []).filter(r => !model.fixed.has(r.ref)).map(r => r.ref));
  const core = poses.filter(p => !edgeRefs.has(p.ref));
  const extent = bounds((core.length ? core : poses).map(p => posedBox(shapes.get(p.ref), p)));
  const preferredEdges = {};
  const rules = [...(model.edgeRules ?? [])].sort((a, b) => a.ref.localeCompare(b.ref));
  for (const rule of rules) {
    if (model.fixed.has(rule.ref)) continue;
    const c = positions.get(rule.ref), shape = shapes.get(rule.ref), block = model.blockRules?.find(b => b.ref === rule.ref);
    const anchorRefs = block?.anchors ?? topo.members.get(topo.membership.get(rule.ref)).filter(ref => ref !== rule.ref);
    const anchors = anchorRefs.map(ref => positions.get(ref)).filter(Boolean);
    const target = anchors.length ? { x: anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length, y: anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length } : c;
    const candidates = [];
    const domain = domains.get(rule.ref);
    for (const state of domain.states) {
      const frame = { ...extent };
      // This temporary envelope is not a board constraint. Ensure a large
      // interface can be represented before choosing its outer packing strip.
      for (const axis of ['x','y']) {
        const lo = axis === 'x' ? 'minX' : 'minY', hi = axis === 'x' ? 'maxX' : 'maxY';
        const extra = Math.max(0, state.bodyOffset[hi] - state.bodyOffset[lo] - (frame[hi]-frame[lo]));
        frame[lo] -= extra/2; frame[hi] += extra/2;
      }
      const decoded = decodeEdgePose(domain, state, frame, { alongMil: Math.round(target[state.tangentAxis] / options.grid) * options.grid });
      if (!decoded) continue;
      const pose = decoded.pose;
      const score = distance(pose, target) + random() * options.strength * (extent.maxX - extent.minX + extent.maxY - extent.minY) * .025;
      candidates.push({ pose, side: state.side, score });
    }
    if (!candidates.length) throw Error('INITIAL_PROPOSAL_NO_ALLOWED_EDGE ' + rule.ref);
    candidates.sort((a, b) => a.score - b.score || SIDES.indexOf(a.side) - SIDES.indexOf(b.side) || a.pose.rotation - b.pose.rotation);
    const choice = candidates[0];
    preferredEdges[rule.ref] = choice.side; Object.assign(c, choice.pose);
  }
  // Place interfaces outside the core, rather than projecting them through
  // existing parts inside it. Each side shares one physical-body extreme, but
  // its depth is chosen from the largest required courtyard on that side.
  // A temporary outline is enlarged only enough for its tangential occupants.
  const groups = new Map(SIDES.map(side => [side, rules.filter(r => preferredEdges[r.ref] === side).map(r => r.ref)]));
  for (const side of SIDES) {
    const refs = groups.get(side), axis = ['left', 'right'].includes(side) ? 'y' : 'x';
    if (!refs.length) continue;
    const min = axis === 'x' ? 'minX' : 'minY', max = axis === 'x' ? 'maxX' : 'maxY';
    const required = refs.reduce((sum, ref) => { const b = posedBox(shapes.get(ref), positions.get(ref)); return sum + b[max] - b[min]; }, 0) + (refs.length + 1) * options.packingGap;
    if (required > extent[max] - extent[min]) { const expansion = (required - extent[max] + extent[min]) / 2; extent[min] -= expansion; extent[max] += expansion; }
  }
  for (const side of SIDES) {
    const refs = groups.get(side);
    if (!refs.length) continue;
    const axis = ['left', 'right'].includes(side) ? 'y' : 'x', min = axis === 'x' ? 'minX' : 'minY', max = axis === 'x' ? 'maxX' : 'maxY';
    const depths = refs.map(ref => {
      const p = positions.get(ref), shape = shapes.get(ref), body = posedBox(shape, { ...ZERO, rotation: p.rotation }, 'body'), court = posedBox(shape, { ...ZERO, rotation: p.rotation });
      return { ref, body, court };
    });
    const normalBoundary = side === 'left' ? extent.minX - options.packingGap - Math.max(...depths.map(s => s.court.maxX - s.body.minX))
      : side === 'right' ? extent.maxX + options.packingGap + Math.max(...depths.map(s => s.body.maxX - s.court.minX))
        : side === 'top' ? extent.minY - options.packingGap - Math.max(...depths.map(s => s.court.maxY - s.body.minY))
          : extent.maxY + options.packingGap + Math.max(...depths.map(s => s.body.maxY - s.court.minY));
    for (const { ref, body, court } of depths) {
      const p = positions.get(ref);
      const domain = domains.get(ref), state = domain.states.find(s => s.side === side && angle(s.rotation) === angle(p.rotation));
      const frame = { ...extent, [state.normalKey]: normalBoundary };
      const alongMil = Math.min(extent[max] - court[max], Math.max(extent[min] - court[min], p[axis]));
      const decoded = decodeEdgePose(domain, state, frame, { alongMil });
      if (!decoded) throw Error('INITIAL_EDGE_PARAMETER_DOMAIN_EMPTY ' + ref);
      Object.assign(p, decoded.pose);
    }
    refs.sort((a, b) => positions.get(a)[axis] - positions.get(b)[axis] || a.localeCompare(b));
    let end = extent[min] - options.packingGap;
    for (const ref of refs) {
      const p = positions.get(ref), b = posedBox(shapes.get(ref), p), delta = Math.max(0, end + options.packingGap - b[min]);
      p[axis] += delta; end = b[max] + delta;
    }
    let start = extent[max] + options.packingGap;
    for (const ref of [...refs].reverse()) {
      const p = positions.get(ref), b = posedBox(shapes.get(ref), p), delta = Math.min(0, start - options.packingGap - b[max]);
      p[axis] += delta; start = b[min] + delta;
    }
  }
  return preferredEdges;
}

function placeTestPads(model, poses, shapes, topo, random, options) {
  const positions = new Map(poses.map(p => [p.ref, p]));
  const obstacles = poses.map(p => ({ ...p, box: posedBox(shapes.get(p.ref), p) }));
  const free = [...model.pads.filter(p => !p.owner)].sort((a, b) => String(a.number).localeCompare(String(b.number), 'en', { numeric: true }));
  const output = [];
  // Locked pads enter the obstacle set first even if their reference sorts last.
  for (const p of free.filter(p => p.locked)) obstacles.push({ ...p, box: p.bbox });
  for (const original of free) {
    if (original.locked) { output.push({ ...original, ref: original.number, bbox: { ...original.bbox } }); continue; }
    const local = box({ minX: original.bbox.minX - original.x, maxX: original.bbox.maxX - original.x, minY: original.bbox.minY - original.y, maxY: original.bbox.maxY - original.y });
    const shape = { ref: original.number, courtyard: local, physical: local, body: local };
    const blockId = topo.membership.get(original.number), blockRefs = topo.members.get(blockId) ?? [];
    const netRefs = sorted(new Set(model.pads.filter(p => p.owner && p.net === original.net).map(p => p.owner)));
    const inBlock = netRefs.filter(ref => blockRefs.includes(ref));
    const refs = inBlock.length ? inBlock : blockRefs.length ? blockRefs : netRefs.length ? netRefs : [...positions.keys()];
    const anchors = refs.map(ref => positions.get(ref)).filter(Boolean);
    if (!anchors.length) throw Error('INITIAL_PROPOSAL_NO_TESTPAD_ANCHOR ' + original.number);
    const target = { x: anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length, y: anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length };
    const clearance = Math.max(options.grid, model.mechanical?.clearanceMil ?? 8);
    let best;
    for (const p of candidatesAround(shape, 0, obstacles, target, options.grid, clearance)) {
      const bbox = posedBox(shape, p);
      if (obstacles.some(o => gap(bbox, o.box) < clearance - .001)) continue;
      const score = distance(p, target) + random() * options.strength * options.grid;
      if (!best || score < best.score) best = { ...p, bbox, score };
    }
    if (!best) throw Error('INITIAL_PROPOSAL_TESTPAD_PACKING_FAILED ' + original.number);
    const value = { ...original, ref: original.number, x: best.x, y: best.y, bbox: best.bbox };
    output.push(value); obstacles.push({ ...value, box: value.bbox });
  }
  return output;
}

/** Generate repeatable *unvalidated* starting layouts from design relationships.
 * With unrestricted cardinal rotations, freely placed source XY/rotation/label
 * sides do not affect the output. Explicit fixed poses and restricted absolute
 * rotation sets remain inputs. Caller must initialize labels and legalize/check.
 */
export function generateInitialProposals(model, options = {}) {
  const seed = options.seed ?? 91021, count = options.count ?? options.startCount ?? 4, strength = options.explorationStrength ?? .65;
  const grid = options.gridMil ?? model.config?.search?.gridMil ?? 5, packingGap = options.packingGapMil ?? 30;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('INVALID_INITIAL_PROPOSAL_SEED');
  if (!Number.isInteger(count) || count < 1 || count > 500) throw Error('INVALID_INITIAL_PROPOSAL_COUNT');
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw Error('INVALID_INITIAL_EXPLORATION_STRENGTH');
  if (!Number.isFinite(grid) || grid <= 0 || !Number.isFinite(packingGap) || packingGap < 0) throw Error('INVALID_INITIAL_PROPOSAL_DISTANCE');
  if (!model.components?.size) throw Error('INITIAL_PROPOSAL_COMPONENTS_REQUIRED');
  const settings = { grid, packingGap, strength }, shapes = localGeometry(model), topo = topology(model), results = [];
  for (let index = 0; index < count; index++) {
    const proposalSeed = (seed + Math.imul(index, 104729)) >>> 0, random = seeded(proposalSeed);
    const blocks = new Map();
    for (const [id, refs] of topo.members) blocks.set(id, packBlock(refs, shapes, topo, random, settings, blocks.size));
    const chosen = chooseBlockArrangement(blocks, topo, random, settings);
    const poses = [];
    for (const [id, block] of blocks) {
      const offset = chosen.arrangement.offsets.get(id);
      for (const p of block.poses) poses.push({ ref: p.ref, x: round(p.x + offset.x), y: round(p.y + offset.y), rotation: p.rotation });
    }
    // Fixed poses are authoritative. Align each block to its first fixed member;
    // preserve every additional fixed member exactly and leave clashes for the
    // same legalizer used by all other proposals.
    const positions = new Map(poses.map(p => [p.ref, p]));
    for (const [id, refs] of topo.members) {
      const fixedRefs = refs.filter(ref => model.fixed.has(ref));
      if (!fixedRefs.length) continue;
      const first = fixedRefs[0], fixed = model.fixed.get(first), current = positions.get(first), dx = fixed.x - current.x, dy = fixed.y - current.y;
      for (const ref of refs) { const p = positions.get(ref); p.x += dx; p.y += dy; }
      for (const ref of fixedRefs) { const f = model.fixed.get(ref); Object.assign(positions.get(ref), { x: f.x, y: f.y, rotation: f.rotation }); }
    }
    const preferredEdges = placeEdges(model, poses, shapes, topo, random, settings);
    const testPads = placeTestPads(model, poses, shapes, topo, random, settings);
    const components = poses.sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true })).map(p => {
      const fixed = model.fixed.get(p.ref);
      return fixed ? { ref: p.ref, x: fixed.x, y: fixed.y, rotation: fixed.rotation }
        : { ...p, x: round(p.x), y: round(p.y), rotation: round(p.rotation) };
    });
    results.push({ components, testPads, preferredEdges, metadata: {
      seed: proposalSeed, requestedSeed: seed, index, mode: 'fresh', explorationStrength: strength, gridMil: grid, packingGapMil: packingGap,
      blockOrder: [...chosen.order], preferredEdges: { ...preferredEdges }, blockAspects: Object.fromEntries([...blocks].map(([id, b]) => [id, b.aspect])),
      blockRows: Object.fromEntries([...chosen.arrangement.offsets].map(([id, o]) => [id, o.row])),
      topologyProxyMil: round(chosen.cost), topologySource: 'explicit-pairs-and-net-hyperedges', fixedRefs: sorted(model.fixed.keys()),
      relationHeuristics: structuredClone(topo.relationHeuristics),
      lockedTestPads: testPads.filter(p => p.locked).map(p => p.number),
      restrictedRotationRefs: sorted([...shapes].filter(([ref, s]) => !model.fixed.has(ref) && s.rotations.length < 4).map(([ref]) => ref)),
      initializesLabels: false, requiresLabelInitialization: true, validated: false,
      limitations: ['Coarse proposal only: assembly, silkscreen, edge, and electrical constraints must be checked by the existing validator.', 'Two-row block extents are temporary packing guides, not hard functional-block regions.', 'Restricted rotation sets and fixed component or pad poses are retained as explicit input.']
    } });
  }
  return results;
}
