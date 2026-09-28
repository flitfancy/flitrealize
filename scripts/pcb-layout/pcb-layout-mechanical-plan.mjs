import { padOwner } from './pcb-layout-geometry.mjs';
import { labelTemplate } from './pcb-layout-label-policy.mjs';
import { layoutLabelAlignment } from './pcb-layout-provider.mjs';
import { assemblyRuntime } from './pcb-layout-assembly-policy.mjs';
import { resolveBoardBounds, boardContains } from './pcb-layout-board.mjs';

// Deterministic geometry only: preserve labels, repair local conflicts, then move bodies.
export function makePlan(snapshot, rules) {
  const labelAlignment = layoutLabelAlignment(snapshot);
  const boardBounds = resolveBoardBounds(null, rules.boardBounds).bounds;
  const gap = rules.clearanceMil ?? 8, eps = .001;
  const relocationLimit = rules.maxRelocationMil ?? 5000;
  if (!Number.isFinite(relocationLimit) || relocationLimit < 0) throw Error('INVALID_RELOCATION_LIMIT');
  const origins = new Map([...snapshot.components.map(c => [c.ref, c]), ...snapshot.pads.filter(p => !!!padOwner(p, snapshot.components)).map(p => [p.number, p])]);
  // A selected edge permits only tangent motion during this repair call. This
  // search restriction is transient: it is not a stored component constraint.
  const relocationAxes = new Map();
  if (rules.relocationAxesByRef !== undefined) {
    const axes = rules.relocationAxesByRef;
    if (!axes || typeof axes !== 'object' || Array.isArray(axes) || ![Object.prototype, null].includes(Object.getPrototypeOf(axes))) throw Error('INVALID_RELOCATION_AXES');
    for (const ref of Reflect.ownKeys(axes)) {
      if (typeof ref !== 'string' || !origins.has(ref)) throw Error('UNKNOWN_RELOCATION_AXIS_REF ' + String(ref));
      if (!['x', 'y', 'none'].includes(axes[ref])) throw Error('INVALID_RELOCATION_AXIS ' + ref);
      relocationAxes.set(ref, axes[ref]);
    }
  }
  const pairKey = (a, b) => JSON.stringify([a, b].sort());
  const pairClearances = new Map();
  const pairClearanceLookup = new Map();
  if (rules.pairClearancesMil !== undefined) {
    if (!Array.isArray(rules.pairClearancesMil)) throw Error('INVALID_PAIR_CLEARANCES');
    for (const pair of rules.pairClearancesMil) {
      if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).some(k => !['a', 'b', 'hardMinMil'].includes(k))) throw Error('INVALID_PAIR_CLEARANCE');
      const { a, b, hardMinMil } = pair;
      if (typeof a !== 'string' || !a || typeof b !== 'string' || !b || a === b || !Number.isFinite(hardMinMil) || hardMinMil < 0) throw Error('INVALID_PAIR_CLEARANCE');
      if (!origins.has(a) || !origins.has(b)) throw Error('UNKNOWN_PAIR_CLEARANCE_REF ' + a + '/' + b);
      const key = pairKey(a, b);
      if (pairClearances.has(key)) throw Error('DUPLICATE_PAIR_CLEARANCE ' + a + '/' + b);
      pairClearances.set(key, { a, b, hardMinMil });
      for (const [ref, peer] of [[a, b], [b, a]]) {
        if (!pairClearanceLookup.has(ref)) pairClearanceLookup.set(ref, new Map());
        pairClearanceLookup.get(ref).set(peer, Math.max(gap, hardMinMil));
      }
    }
  }
  // Keep ownership out of the public four-coordinate geometry schema.
  const boxOwners = new WeakMap(), assemblyBoxes = new WeakMap(), physicalBoxes = new WeakMap();
  const union = bs => ({ minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) });
  const shift = (b, x, y) => ({ minX: b.minX + x, maxX: b.maxX + x, minY: b.minY + y, maxY: b.maxY + y });
  const boardShapes = new Map(boardBounds ? [...origins].map(([ref, c]) => {
    const pads = snapshot.components.some(p => p.ref === ref) ? snapshot.pads.filter(p => padOwner(p, snapshot.components)?.ref === ref) : [];
    return [ref, shift(union([c.bbox, ...pads.map(p => p.bbox)]), -c.x, -c.y)];
  }) : []);
  // Courtyards use only the current body/pad pose, never the selected label side.
  const assembly = rules.assemblyPolicy ? assemblyRuntime(rules.assemblyPolicy, snapshot.components, snapshot.pads) : null;
  const assemblyGeometryIssue = assembly?.issues.find(i => !['ASSEMBLY_COURTYARD_OVERLAP', 'ASSEMBLY_PHYSICAL_CLEARANCE', 'ASSEMBLY_DIRECTIONAL_CLEARANCE'].includes(i.code));
  if (assemblyGeometryIssue) throw Error('ASSEMBLY_GEOMETRY_INVALID ' + JSON.stringify(assemblyGeometryIssue));
  const localAssembly = new Map((assembly?.courtyards ?? []).map(c => {
    const origin = origins.get(c.ref);
    if (!origin) throw Error('UNKNOWN_ASSEMBLY_REF ' + c.ref);
    return [c.ref, shift(c.bbox, -origin.x, -origin.y)];
  }));
  const localPhysical = new Map((assembly?.physical ?? []).map(c => {
    const origin = origins.get(c.ref);
    if (!origin) throw Error('UNKNOWN_ASSEMBLY_REF ' + c.ref);
    return [c.ref, shift(c.bbox, -origin.x, -origin.y)];
  }));
  const physicalClearances = new Map((rules.assemblyPolicy?.pairClearancesMil ?? []).map(p => [pairKey(p.a, p.b), p.hardMinMil]));
  const physicalFloor = rules.assemblyPolicy?.absoluteFloorMil ?? 0;
  if (assembly && (localAssembly.size !== origins.size || [...origins.keys()].some(ref => !localAssembly.has(ref)))) throw Error('ASSEMBLY_COVERAGE_INCOMPLETE');
  const owned = (box, ref, x, y) => {
    if (pairClearances.size || assembly) boxOwners.set(box, ref);
    if (assembly) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw Error('ASSEMBLY_POSE_MISSING ' + ref);
      assemblyBoxes.set(box, shift(localAssembly.get(ref), x, y));
      physicalBoxes.set(box, shift(localPhysical.get(ref), x, y));
    }
    return box;
  };
  const bundleApart = (a, b) => {
    let required = gap;
    if (pairClearances.size) {
      const refA = boxOwners.get(a), refB = boxOwners.get(b);
      if (!refA || !refB) throw Error('MISSING_PAIR_CLEARANCE_OWNER');
      required = pairClearanceLookup.get(refA)?.get(refB) ?? gap;
    }
    return a.maxX + required + .05 <= b.minX + eps || b.maxX + required + .05 <= a.minX + eps || a.maxY + required + .05 <= b.minY + eps || b.maxY + required + .05 <= a.minY + eps;
  };
  const assemblyApart = (a, b) => {
    if (!assembly) return true;
    const aa = assemblyBoxes.get(a), bb = assemblyBoxes.get(b);
    if (!aa || !bb) throw Error('MISSING_ASSEMBLY_GEOMETRY');
    return aa.maxX <= bb.minX + 1e-7 || bb.maxX <= aa.minX + 1e-7 || aa.maxY <= bb.minY + 1e-7 || bb.maxY <= aa.minY + 1e-7;
  };
  const physicalApart = (a, b) => {
    if (!assembly) return true;
    const aa = physicalBoxes.get(a), bb = physicalBoxes.get(b), ca = assemblyBoxes.get(a), cb = assemblyBoxes.get(b);
    if (!aa || !bb || !ca || !cb) throw Error('MISSING_ASSEMBLY_PHYSICAL_GEOMETRY');
    const required = physicalClearances.size ? Math.max(physicalFloor, physicalClearances.get(pairKey(boxOwners.get(a), boxOwners.get(b))) ?? 0) : physicalFloor;
    // One separating axis must satisfy both physical requirements. Combining
    // a courtyard separation on Y with a physical floor on X is insufficient.
    return ca.maxX <= cb.minX + 1e-7 && aa.maxX + required <= bb.minX + 1e-7
      || cb.maxX <= ca.minX + 1e-7 && bb.maxX + required <= aa.minX + 1e-7
      || ca.maxY <= cb.minY + 1e-7 && aa.maxY + required <= bb.minY + 1e-7
      || cb.maxY <= ca.minY + 1e-7 && bb.maxY + required <= aa.minY + 1e-7;
  };
  const physicalIssueCode = (a, b) => {
    const aa = physicalBoxes.get(a), bb = physicalBoxes.get(b);
    const required = physicalClearances.size ? Math.max(physicalFloor, physicalClearances.get(pairKey(boxOwners.get(a), boxOwners.get(b))) ?? 0) : physicalFloor;
    const gap = Math.max(bb.minX - aa.maxX, aa.minX - bb.maxX, bb.minY - aa.maxY, aa.minY - bb.maxY);
    return gap + 1e-7 < required ? 'ASSEMBLY_PHYSICAL_CLEARANCE' : 'ASSEMBLY_DIRECTIONAL_CLEARANCE';
  };
  const apart = (a, b) => bundleApart(a, b) && assemblyApart(a, b) && physicalApart(a, b);
  const rotated = b => ({ minX: -b.maxY, maxX: -b.minY, minY: b.minX, maxY: b.maxX });
  const locked = new Set(rules.lockedDesignators ?? []);
  const stats = { labelRepairAttempts: 0, labelRepairSuccesses: 0, searchNodes: 0, searchLimitHits: 0, componentFallbacks: 0, testPadFallbacks: 0 };
  if (relocationAxes.size) Object.assign(stats, { axisRestrictedRelocationAttempts: 0, axisRestrictedOffsetsTried: 0 });

  function variants(c) {
    const texts = snapshot.items.filter(t => t.owner === c.ref).sort((a, b) => a.type.localeCompare(b.type));
    if (!texts.some(t => t.type === 'attribute')) throw Error('Missing native designator ' + c.ref);
    const body = shift(c.bbox, -c.x, -c.y), pp = snapshot.pads.filter(p => padOwner(p, snapshot.components)?.id === c.id);
    if (!pp.length) throw Error('Missing pad geometry ' + c.ref);
    const pad = shift(union(pp.map(p => p.bbox)), -c.x, -c.y);
    const width = Math.max(...texts.map(t => t.width)), height = texts.reduce((n, t) => n + t.height, 0) + (texts.length - 1) * gap;
    const template = labelTemplate(c, rules);
    const border = template.anchor === 'pads' ? pad : union([body, pad]), ownGap = Math.max(gap, template.minGapMil);
    const vertical = body.maxY - body.minY > (body.maxX - body.minX) * 1.2;
    const sides = vertical ? ['left', 'right', 'bottom', 'top'] : ['bottom', 'top', 'right', 'left'];
    const metadata = t => ({ id: t.id, type: t.type, owner: c.ref, parentId: t.parentId, text: t.text, fontSize: t.fontSize, lineWidth: t.lineWidth });
    const canonical = sides.map(side => {
      const rot = side === 'left' || side === 'right' ? 90 : 0, w = rot ? height : width, h = rot ? width : height;
      let x = (body.minX + body.maxX - w) / 2, y = (body.minY + body.maxY - h) / 2;
      if (side === 'bottom') y = Math.ceil((border.maxY + ownGap - .02) / 5) * 5;
      if (side === 'top') y = Math.floor((border.minY - ownGap - h + .02) / 5) * 5;
      if (side === 'right') x = Math.ceil((border.maxX + ownGap - .02) / 5) * 5;
      if (side === 'left') x = Math.floor((border.minX - ownGap - w + .02) / 5) * 5;
      let offset = 0;
      const labels = texts.map(t => {
        const bx = (width - t.width) / 2, b = { minX: bx, maxX: bx + t.width, minY: offset, maxY: offset + t.height };
        offset += t.height + gap;
        const tb = rot ? shift(rotated(b), x + height, y) : shift(b, x, y);
        return { ...metadata(t), rotation: rot, alignMode: labelAlignment.bottomLeft, x: rot ? tb.maxX : tb.minX, y: tb.minY, bbox: tb };
      });
      return { side, body, labels, bbox: union([body, ...labels.map(l => l.bbox)]) };
    });
    if (rules.initializeLabels) return canonical;

    // Preserve exact existing anchors and alignment; template only the other sides.
    const labels = texts.map(t => ({ ...metadata(t), ...t.original, x: t.original.x - c.x, y: t.original.y - c.y, bbox: shift(t.original.bbox, -c.x, -c.y) }));
    const textBox = union(labels.map(l => l.bbox));
    const distance = opt => {
      const b = union(opt.labels.map(l => l.bbox));
      return (b.minX + b.maxX - textBox.minX - textBox.maxX) ** 2 + (b.minY + b.maxY - textBox.minY - textBox.maxY) ** 2;
    };
    const side = [...canonical].sort((a, b) => distance(a) - distance(b))[0].side;
    const options = [{ side, body, labels, bbox: union([body, textBox]) }, ...canonical.filter(o => o.side !== side)];
    const preferred = rules.preferredLabelSides?.[c.ref];
    if (preferred !== undefined && !sides.includes(preferred)) throw Error('INVALID_LABEL_SIDE ' + c.ref);
    return preferred === undefined ? options : [options.find(o => o.side === preferred), ...options.filter(o => o.side !== preferred)];
  }

  // Include every body and test pad before allowing labels to claim space.
  const entries = snapshot.components.map(c => ({ ...c, kind: 'component', locked: c.locked || locked.has(c.ref), options: variants(c), selected: 0 }));
  for (const p of snapshot.pads.filter(p => !!!padOwner(p, snapshot.components))) {
    entries.push({ ...p, ref: p.number, kind: 'testPad', locked: !!p.locked, selected: 0, options: [{ side: null, labels: [], body: shift(p.bbox, -p.x, -p.y), bbox: shift(p.bbox, -p.x, -p.y) }] });
  }
  // Sorting only: translated equal-size objects can differ by cancellation
  // noise. A stable tie must fall through to ref, not reshuffle TP repair order.
  const area = e => Math.round((e.bbox.maxX - e.bbox.minX) * (e.bbox.maxY - e.bbox.minY) * 1e4) / 1e4;
  entries.sort((a, b) => Number(b.locked) - Number(a.locked) || Number(a.kind === 'testPad') - Number(b.kind === 'testPad') || area(b) - area(a) || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  const bbox = (e, option = e.selected, x = e.x, y = e.y) => owned(shift(e.options[option].bbox, x, y), e.ref, x, y);
  const onBoard = (e, option = e.selected, x = e.x, y = e.y) => !boardBounds || boardContains(boardBounds, union([shift(boardShapes.get(e.ref), x, y), bbox(e, option, x, y)]));
  const conflicts = () => {
    const pairs = [];
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) if (!apart(bbox(entries[i]), bbox(entries[j]))) pairs.push([i, j]);
    return pairs;
  };
  const optionOrder = e => [e.selected, ...e.options.map((_, i) => i).filter(i => i !== e.selected)];

  function repairLabels(pair) {
    const a = entries[pair[0]], b = entries[pair[1]];
    if (!apart(owned(shift(a.options[0].body, a.x, a.y), a.ref, a.x, a.y), owned(shift(b.options[0].body, b.x, b.y), b.ref, b.x, b.y))) return false;
    const cluster = pair.filter(i => entries[i].options.length > 1);
    if (!cluster.length) return false;
    stats.labelRepairAttempts++;
    const maxComponents = rules.localSearchMaxComponents ?? 6, maxNodes = rules.localSearchMaxNodes ?? 4096;
    // Only expand around potential label conflicts, with a small fixed limit.
    for (let cursor = 0; cursor < cluster.length && cluster.length < maxComponents; cursor++) {
      const e = entries[cluster[cursor]];
      for (let j = 0; j < entries.length && cluster.length < maxComponents; j++) {
        if (cluster.includes(j) || entries[j].options.length < 2) continue;
        if (e.options.some((_, opt) => !apart(bbox(e, opt), bbox(entries[j])))) cluster.push(j);
      }
    }
    const outside = entries.filter((_, i) => !cluster.includes(i)).map(e => bbox(e));
    const domains = cluster.map(i => ({ i, opts: optionOrder(entries[i]).filter(o => onBoard(entries[i], o) && outside.every(b => apart(bbox(entries[i], o), b))) }));
    if (domains.some(d => !d.opts.length)) return false;
    domains.sort((a, b) => a.opts.length - b.opts.length || a.i - b.i);
    const assignments = [], occupied = [];
    let nodes = 0;
    function search(depth) {
      if (depth === domains.length) return true;
      const d = domains[depth];
      for (const opt of d.opts) {
        if (nodes >= maxNodes) return false;
        nodes++;
        const b = bbox(entries[d.i], opt);
        if (!occupied.every(p => apart(b, p))) continue;
        assignments.push([d.i, opt]); occupied.push(b);
        if (search(depth + 1)) return true;
        assignments.pop(); occupied.pop();
      }
      return false;
    }
    const found = search(0);
    stats.searchNodes += nodes;
    if (!found && nodes >= maxNodes) stats.searchLimitHits++;
    if (!found) return false;
    for (const [i, opt] of assignments) entries[i].selected = opt;
    stats.labelRepairSuccesses++;
    return true;
  }

  // Repairs remove conflicts without creating new ones. Trials do not mutate EDA.
  let repaired = true;
  while (repaired) {
    repaired = false;
    for (const pair of conflicts()) if (repairLabels(pair)) { repaired = true; break; }
  }

  function relocate(index) {
    const e = entries[index];
    if (e.locked || (rules.relocatableRefs && !rules.relocatableRefs.includes(e.ref))) return false;
    const axis = relocationAxes.get(e.ref);
    if (axis !== undefined) stats.axisRestrictedRelocationAttempts++;
    const others = entries.filter((_, i) => i !== index).map(e => bbox(e));
    const radiusLimit = !boardBounds ? relocationLimit : Math.min(relocationLimit, Math.ceil(Math.max(Math.abs(e.x-boardBounds.minX),Math.abs(e.x-boardBounds.maxX),Math.abs(e.y-boardBounds.minY),Math.abs(e.y-boardBounds.maxY)) / 5) * 5);
    for (let radius = 0; radius <= (axis === 'none' ? 0 : radiusLimit); radius += 5) {
      const offsets = radius ? [] : [[0, 0]];
      if (radius) {
        if (axis === 'x') offsets.push([-radius, 0], [radius, 0]);
        else if (axis === 'y') offsets.push([0, -radius], [0, radius]);
        else {
          for (let d = -radius; d <= radius; d += 5) {
            offsets.push([-radius, d], [radius, d]);
            if (Math.abs(d) !== radius) offsets.push([d, -radius], [d, radius]);
          }
          offsets.sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2);
        }
      }
      for (const [dx, dy] of offsets) {
        if (axis !== undefined) stats.axisRestrictedOffsetsTried++;
        for (const opt of optionOrder(e)) {
          const origin = origins.get(e.ref);
          if (Math.max(Math.abs(e.x + dx - origin.x), Math.abs(e.y + dy - origin.y)) > relocationLimit + eps) continue;
          if (!onBoard(e, opt, e.x + dx, e.y + dy)) continue;
          if (!others.every(p => apart(bbox(e, opt, e.x + dx, e.y + dy), p))) continue;
          if (dx) e.x += dx;
          if (dy) e.y += dy;
          e.selected = opt;
          if (dx || dy) stats[e.kind === 'component' ? 'componentFallbacks' : 'testPadFallbacks']++;
          return true;
        }
      }
    }
    return false;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (onBoard(e)) continue;
    const labelSide = optionOrder(e).find(opt => onBoard(e,opt) && entries.every((other,j) => i===j || apart(bbox(e,opt),bbox(other))));
    if (labelSide !== undefined) e.selected = labelSide;
    else relocate(i);
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const pair of conflicts()) {
      if (repairLabels(pair) || relocate(pair[1]) || relocate(pair[0])) { progressed = true; break; }
    }
  }

  const components = [], labels = [], testPads = [];
  for (const e of entries) {
    if (e.kind === 'testPad') {
      const before = snapshot.pads.find(p => p.id === e.id);
      testPads.push({ id: e.id, number: e.number, net: e.net, x: e.x, y: e.y, dx: e.x - before.x, dy: e.y - before.y, bbox: bbox(e) });
      continue;
    }
    const before = snapshot.components.find(c => c.id === e.id), opt = e.options[e.selected];
    components.push({ id: e.id, ref: e.ref, x: e.x, y: e.y, rotation: e.rotation, dx: e.x - before.x, dy: e.y - before.y, body: shift(opt.body, e.x, e.y), side: opt.side, defaultSide: e.options[0].side });
    labels.push(...opt.labels.map(l => ({ ...l, x: l.x + e.x, y: l.y + e.y, bbox: shift(l.bbox, e.x, e.y) })));
  }
  for (const l of labels) {
    const old = snapshot.items.find(t => t.id === l.id).original;
    l.changed = Math.abs(old.x - l.x) > eps || Math.abs(old.y - l.y) > eps || old.rotation !== l.rotation || old.alignMode !== l.alignMode;
  }
  const labelsChanged = labels.filter(l => l.changed).length;
  const issues = conflicts().flatMap(pair => {
    const boxes = pair.map(i => bbox(entries[i])), refs = pair.map(i => entries[i].ref), found = [];
    if (!bundleApart(...boxes)) found.push({ code: 'MIN_CLEARANCE_UNSATISFIED', refs });
    if (!assemblyApart(...boxes)) found.push({ code: 'ASSEMBLY_COURTYARD_OVERLAP', refs });
    else if (!physicalApart(...boxes)) found.push({ code: physicalIssueCode(...boxes), refs });
    return found;
  });
  for (const e of entries) if (!onBoard(e)) issues.push({ code: 'BOARD_BOUNDARY_VIOLATION', ref: e.ref, kind: e.kind, boardBounds });
  return {
    status: issues.length ? 'planned-with-issues' : 'planned', sourceHash: snapshot.sourceHash, sourceBefore: snapshot.source,
    boardBounds, clearanceMil: gap, initializeLabels: !!rules.initializeLabels, components, labels, testPads,
    ...(pairClearances.size ? { pairClearancesMil: [...pairClearances.values()] } : {}),
    bundles: entries.map(e => ({ ref: e.ref, bbox: bbox(e) })), issues, search: stats,
    counts: { components: components.length, moved: components.filter(c => c.dx || c.dy).length, labels: labels.length, labelsChanged, labelSidesChanged: components.filter(c => c.side !== c.defaultSide).length, testPads: testPads.length, testPadsMoved: testPads.filter(p => p.dx || p.dy).length },
    maxMoveMil: Math.max(0, ...components.map(c => Math.hypot(c.dx, c.dy)))
  };
}
