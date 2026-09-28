import { angle, transformPoint, transformBox, padOwner } from './pcb-layout-geometry.mjs';
import { layoutRealization } from './pcb-layout-provider.mjs';
import { resolveBoardBounds, checkBoardBounds } from './pcb-layout-board.mjs';
import { compileAssemblyPolicy, evaluateAssemblyPolicy } from './pcb-layout-assembly-policy.mjs';

const fail = (code, detail = '') => { throw Object.assign(Error(code + (detail ? ': ' + detail : '')), { code }); };
const near = (a, b) => Math.abs(a - b) <= .001;
const text = v => typeof v === 'string' && v.trim() === v && v.length > 0;
const boxKeys = ['minX', 'minY', 'maxX', 'maxY'];
const validBox = b => b && boxKeys.every(k => Number.isFinite(b[k])) && b.maxX > b.minX && b.maxY > b.minY;
const union = boxes => ({ minX: Math.min(...boxes.map(b => b.minX)), minY: Math.min(...boxes.map(b => b.minY)), maxX: Math.max(...boxes.map(b => b.maxX)), maxY: Math.max(...boxes.map(b => b.maxY)) });
const gap = (a, b) => Math.max(b.minX - a.maxX, a.minX - b.maxX, b.minY - a.maxY, a.minY - b.maxY);
const issueKey = i => JSON.stringify([i.code, i.refs, i.ref, i.id, i.region]);
function names(value, label) {
  if (!Array.isArray(value) || value.some(n => !text(n)) || new Set(value).size !== value.length) fail('INVALID_NAMES', label);
  return value;
}
function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_OBJECT', label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('UNKNOWN_FIELD', label + '.' + key);
}
function hpwl(pads, net) {
  const points = pads.filter(p => p.net === net);
  if (!points.length) fail('UNKNOWN_AUDIT_NET', net);
  return { pads: points.length, hpwlMil: Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) };
}
function endpoint(pads, value, net) {
  exactKeys(value, ['ref', 'pad'], 'padPair.endpoint');
  if (!text(value.ref) || !(text(value.pad) || Number.isInteger(value.pad))) fail('INVALID_PAD_ENDPOINT');
  const found = pads.filter(p => (p.owner ?? p.number) === value.ref && String(p.number) === String(value.pad));
  if (found.length !== 1 || found[0].net !== net) fail('PAD_ENDPOINT_MISMATCH', value.ref + '.' + value.pad);
  return found[0];
}
function pairMeasure(pads, pair) {
  const a = endpoint(pads, pair.a, pair.net), b = endpoint(pads, pair.b, pair.net);
  return { euclideanMil: Math.hypot(a.x - b.x, a.y - b.y), manhattanMil: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) };
}

/** Compare explicit local proposals. This function does not search, read EDA, or apply moves. */
export function reviewFineLayout(snapshot, request, assemblyRules = null) {
  exactKeys(request, ['schemaVersion', 'expectedSourceHash', 'movableDesignators', 'planInput', 'audit'], 'request');
  if (request.schemaVersion !== 1) fail('INVALID_FINE_REVIEW_VERSION');
  const plan = request.planInput;
  exactKeys(plan, ['mode', 'expectedProjectUuid', 'expectedDocumentUuid', 'boardBounds', 'lockedDesignators', 'reservedRegions', 'clearanceMil', 'cellMil', 'placements', 'groups', 'scenarios'], 'planInput');
  if (plan.mode !== 'plan' || !text(plan.expectedProjectUuid) || !text(plan.expectedDocumentUuid)) fail('TARGET_REQUIRED');
  if (!snapshot || snapshot.document?.uuid !== plan.expectedDocumentUuid || snapshot.document?.parentProjectUuid !== plan.expectedProjectUuid) fail('TARGET_MISMATCH');
  if (!(Number.isSafeInteger(snapshot.sourceHash) || text(snapshot.sourceHash)) || request.expectedSourceHash !== snapshot.sourceHash) fail('SNAPSHOT_CHANGED');
  if (snapshot.units !== 'mil' || !['eda-y-up', 'cartesian-y-up'].includes(snapshot.coordinateSystem)) fail('UNSUPPORTED_SNAPSHOT_COORDINATES');
  if (!Array.isArray(snapshot.components) || !snapshot.components.length || !Array.isArray(snapshot.pads) || !Array.isArray(snapshot.outlines) || !Array.isArray(snapshot.regions)) fail('INCOMPLETE_SNAPSHOT');
  const routingKeys = ['Line', 'Arc', 'Polyline', 'Via', 'Pour'];
  if (!snapshot.routing || routingKeys.some(k => !Number.isInteger(snapshot.routing[k]) || snapshot.routing[k] < 0)) fail('ROUTING_OBSERVATION_REQUIRED');
  const copperPresent = routingKeys.some(k => snapshot.routing[k] > 0);
  const components = snapshot.components;
  if (components.some(c => !text(c.id) || !text(c.ref) || ![c.x, c.y, c.rotation].every(Number.isFinite) || typeof c.locked !== 'boolean' || !validBox(c.bbox))) fail('INVALID_COMPONENT_GEOMETRY');
  if (new Set(components.map(c => c.id)).size !== components.length || new Set(components.map(c => c.ref)).size !== components.length) fail('DUPLICATE_COMPONENT');
  const byRef = new Map(components.map(c => [c.ref, c]));
  const movable = names(request.movableDesignators, 'movableDesignators');
  const locked = names(plan.lockedDesignators, 'lockedDesignators');
  for (const ref of [...movable, ...locked]) if (!byRef.has(ref)) fail('UNKNOWN_COMPONENT', ref);
  if (!Number.isFinite(plan.clearanceMil) || plan.clearanceMil < 0 || !Array.isArray(plan.reservedRegions)) fail('LAYOUT_CONSTRAINTS_REQUIRED');
  if (plan.cellMil !== undefined && (!Number.isFinite(plan.cellMil) || plan.cellMil <= 0)) fail('INVALID_GRID');
  for (const r of [...snapshot.regions, ...plan.reservedRegions]) if (!validBox(r.bbox)) fail('REGION_GEOMETRY_REQUIRED');
  const pads = snapshot.pads.map(p => {
    if (!text(p.id) || ![p.x, p.y].every(Number.isFinite) || !validBox(p.bbox) || p.number == null) fail('INVALID_PAD_GEOMETRY');
    return { ...p, owner: padOwner(p, byRef)?.ref ?? null };
  });
  if (new Set(pads.map(p => p.id)).size !== pads.length) fail('DUPLICATE_PAD');
  const target = { expectedProjectUuid: plan.expectedProjectUuid, expectedDocumentUuid: plan.expectedDocumentUuid };
  const realization = layoutRealization(snapshot, null, snapshot.provider, target);
  if (realization.provider !== 'easyeda-pro') fail('FINE_EXECUTOR_UNSUPPORTED', realization.provider);
  const board = resolveBoardBounds(realization.board, plan.boardBounds);
  const coverage = {
    geometry: 'component-and-pad-bounding-boxes', assembly: assemblyRules ? 'configured' : 'not-checked',
    silkscreen: 'not-checked', electricalTopology: 'not-checked', drc: 'not-run',
    executor: 'pcb-placement', livePlanRequired: true,
  };
  const base = { schemaVersion: 1, kind: 'flitrealize.pcb-fine-layout.review', readOnly: true, nativeWrites: 0, sourceHash: snapshot.sourceHash, target, board, coverage };
  // Configured dimensions are a board creation input, never proof of an existing board.
  if (realization.board?.status === 'none') {
    const b = board.bounds;
    return { ...base, status: 'board-outline-required', candidates: [], boardOutlineRequest: b ? {
      mode: 'plan', ...target, rect: { originX: b.minX, originY: b.minY, widthMil: b.maxX - b.minX, heightMil: b.maxY - b.minY }, lineWidthMil: 10,
    } : null, next: b ? 'Create and verify the outline with pcb-board-outline, then read a new snapshot.' : 'Provide mechanical board dimensions, create the outline, then read a new snapshot.' };
  }
  if (!board.bounds) fail('BOARD_REQUIRED');
  const audit = request.audit ?? {};
  exactKeys(audit, ['nets', 'padPairs'], 'audit');
  if (audit.nets !== undefined) names(audit.nets, 'audit.nets');
  const pairs = audit.padPairs ?? [];
  if (!Array.isArray(pairs)) fail('INVALID_PAD_PAIRS');
  const pairIds = new Set();
  for (const pair of pairs) {
    exactKeys(pair, ['id', 'net', 'a', 'b', 'maxDistanceMil', 'metric'], 'padPair');
    if (!text(pair.id) || pairIds.has(pair.id) || !text(pair.net)) fail('INVALID_PAD_PAIR');
    pairIds.add(pair.id);
    if (pair.metric !== undefined && !['euclidean', 'manhattan'].includes(pair.metric)) fail('INVALID_PAIR_METRIC');
    if (pair.maxDistanceMil !== undefined && (!Number.isFinite(pair.maxDistanceMil) || pair.maxDistanceMil < 0)) fail('INVALID_PAIR_LIMIT');
    pairMeasure(pads, pair);
  }
  if (plan.scenarios !== undefined && (plan.placements !== undefined || plan.groups !== undefined)) fail('AMBIGUOUS_SCENARIOS');
  const scenarios = plan.scenarios ?? [{ name: 'local-proposal', placements: plan.placements ?? [], groups: plan.groups ?? [] }];
  if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length > 20) fail('INVALID_SCENARIOS');
  if (new Set(scenarios.map(s => s.name)).size !== scenarios.length) fail('DUPLICATE_SCENARIO');
  const assembly = compileAssemblyPolicy(snapshot, assemblyRules);
  const geometryIssues = (cs, ps) => {
    const occupied = cs.map(c => ({ id: c.id, ref: c.ref, kind: 'component', bbox: union([c.bbox, ...ps.filter(p => p.owner === c.ref).map(p => p.bbox)]) }))
      .concat(ps.filter(p => !p.owner).map(p => ({ ...p, ref: p.number, kind: 'standalone-pad' })));
    const issues = checkBoardBounds(board.bounds, occupied);
    for (let i = 0; i < occupied.length; i++) {
      for (let j = i + 1; j < occupied.length; j++) if (gap(occupied[i].bbox, occupied[j].bbox) < plan.clearanceMil - .001) issues.push({ code: 'PHYSICAL_ENVELOPE_CLEARANCE', refs: [occupied[i].ref, occupied[j].ref].sort() });
      for (const r of [...snapshot.regions, ...plan.reservedRegions]) if (gap(occupied[i].bbox, r.bbox) < plan.clearanceMil - .001) issues.push({ code: 'RESERVED_REGION', ref: occupied[i].ref, region: r.id ?? r.name ?? 'unnamed' });
    }
    return issues.concat(evaluateAssemblyPolicy(assembly, cs, ps).issues);
  };
  const baselineIssues = geometryIssues(components, pads);
  for (const pair of pairs) if (pair.maxDistanceMil !== undefined && pairMeasure(pads, pair)[(pair.metric ?? 'euclidean') + 'Mil'] > pair.maxDistanceMil + .001) {
    baselineIssues.push({ code: 'PAD_PAIR_DISTANCE', id: pair.id, maxDistanceMil: pair.maxDistanceMil });
  }
  const baselineKeys = new Set(baselineIssues.map(issueKey));
  const candidates = scenarios.map(scenario => {
    exactKeys(scenario, ['name', 'placements', 'groups'], 'scenario');
    if (!text(scenario.name) || !/^[a-zA-Z0-9_-]+$/.test(scenario.name)) fail('INVALID_SCENARIO_NAME');
    const requested = structuredClone(scenario.placements ?? []);
    if (!Array.isArray(requested) || !Array.isArray(scenario.groups ?? [])) fail('INVALID_PLACEMENTS');
    for (const group of scenario.groups ?? []) {
      exactKeys(group, ['designators', 'dxMil', 'dyMil'], 'group');
      names(group.designators, 'group.designators');
      if (!group.designators.length || ![group.dxMil, group.dyMil].every(Number.isFinite)) fail('INVALID_GROUP');
      for (const ref of group.designators) { const c = byRef.get(ref); if (!c) fail('UNKNOWN_COMPONENT', ref); requested.push({ designator: ref, x: c.x + group.dxMil, y: c.y + group.dyMil }); }
    }
    if (requested.length > 100) fail('BATCH_TOO_LARGE');
    const targets = new Map(), issues = [];
    for (const wanted of requested) {
      exactKeys(wanted, ['designator', 'x', 'y', 'rotation'], 'placement');
      const old = byRef.get(wanted.designator);
      if (!old) fail('UNKNOWN_COMPONENT', wanted.designator);
      if (targets.has(old.ref)) fail('DUPLICATE_SELECTION', old.ref);
      const next = { ...old, x: wanted.x, y: wanted.y, rotation: wanted.rotation ?? old.rotation };
      if (![next.x, next.y, next.rotation].every(Number.isFinite)) fail('INVALID_PLACEMENT', old.ref);
      const delta = angle(next.rotation - old.rotation);
      if (![0, 90, 180, 270].includes(delta)) fail('UNSUPPORTED_ROTATION', old.ref);
      if (delta === 0) next.rotation = old.rotation;
      const changed = !near(next.x, old.x) || !near(next.y, old.y) || delta !== 0;
      if (changed && (!movable.includes(old.ref) || locked.includes(old.ref) || old.locked)) issues.push({ code: 'FIXED_COMPONENT_CHANGED', ref: old.ref });
      targets.set(old.ref, { ...next, bbox: transformBox(old.bbox, old, next) });
    }
    const projected = components.map(c => targets.get(c.ref) ?? c);
    const projectedPads = pads.map(p => {
      const old = byRef.get(p.owner), next = targets.get(p.owner);
      return next ? { ...p, ...transformPoint(p, old, next), bbox: transformBox(p.bbox, old, next) } : p;
    });
    const changes = projected.filter(c => { const old = byRef.get(c.ref); return !near(c.x, old.x) || !near(c.y, old.y) || angle(c.rotation - old.rotation) !== 0; })
      .map(c => ({ designator: c.ref, x: c.x, y: c.y, rotation: c.rotation }));
    const movedRefs = new Set(changes.map(c => c.designator));
    const auditedNets = audit.nets ?? [...new Set(pads.filter(p => movedRefs.has(p.owner) && p.net).map(p => p.net))].sort();
    const netMetrics = auditedNets.map(net => { const before = hpwl(pads, net), after = hpwl(projectedPads, net); return { net, pads: before.pads, beforeMil: before.hpwlMil, afterMil: after.hpwlMil, deltaMil: after.hpwlMil - before.hpwlMil }; });
    const pairMetrics = pairs.map(pair => {
      const before = pairMeasure(pads, pair), after = pairMeasure(projectedPads, pair), metric = pair.metric ?? 'euclidean';
      if (pair.maxDistanceMil !== undefined && after[metric + 'Mil'] > pair.maxDistanceMil + .001) issues.push({ code: 'PAD_PAIR_DISTANCE', id: pair.id, maxDistanceMil: pair.maxDistanceMil });
      return { id: pair.id, net: pair.net, metric, beforeMil: before[metric + 'Mil'], afterMil: after[metric + 'Mil'], deltaMil: after[metric + 'Mil'] - before[metric + 'Mil'] };
    });
    issues.push(...geometryIssues(projected, projectedPads));
    const executionIssues = copperPresent && changes.length ? [{ code: 'EXECUTOR_REQUIRES_UNROUTED_BOARD', message: 'pcb-placement does not carry or reroute copper. Use a routed-placement executor and verify affected connections.' }] : [];
    const keys = new Set(issues.map(issueKey));
    const placementPlanRequest = issues.length || executionIssues.length ? null : {
      mode: 'plan', ...target, boardBounds: board.bounds, lockedDesignators: [...new Set([...locked, ...components.filter(c => !movable.includes(c.ref) || c.locked).map(c => c.ref)])],
      reservedRegions: structuredClone(plan.reservedRegions), clearanceMil: plan.clearanceMil,
      ...(plan.cellMil === undefined ? {} : { cellMil: plan.cellMil }), placements: changes,
    };
    return { name: scenario.name, changes, metrics: { nets: netMetrics, padPairs: pairMetrics }, issues, executionIssues,
      introducedIssues: issues.filter(i => !baselineKeys.has(issueKey(i))), resolvedIssues: baselineIssues.filter(i => !keys.has(issueKey(i))),
      placementPlanRequest, geometry: { components: projected.map(c => ({ ref: c.ref, x: c.x, y: c.y, rotation: c.rotation, bbox: c.bbox })), pads: projectedPads.map(p => ({ id: p.id, owner: p.owner, number: p.number, net: p.net, x: p.x, y: p.y, bbox: p.bbox })) } };
  });
  return { ...base, status: 'reviewed', baseline: { issues: baselineIssues }, candidates,
    limitations: ['HPWL and pad distances are placement proxies, not copper routing or electrical acceptance.', 'Existing project edge, thermal, mechanical and other requirements must also be reviewed before applying a proposal.', 'No standalone pad or silkscreen edits are generated; only observed pads participate in the audit.'] };
}
