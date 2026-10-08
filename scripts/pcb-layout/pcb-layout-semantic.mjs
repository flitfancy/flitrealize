// Convert authoritative intent to flexible physical groups. No native writes.
// Role heuristics are opt-in policy data, never project designators or templates.
import { hash } from './pcb-layout-project.mjs';

export function convertSemanticInputs(model, policy = model.config.semanticPolicy ?? {}) {
  const intent = new Map(model.contract.components.map(c => [c.designator, c]));
  const components = new Map([...model.components.keys()].map(ref => [ref, intent.get(ref) ?? { designator: ref, role: '', pins: [] }]));
  const parent = new Map([...components.keys()].map(ref => [ref, ref]));
  const find = ref => { const p = parent.get(ref); if (p !== ref) parent.set(ref, find(p)); return parent.get(ref); };
  const join = (a, b) => { if (components.has(a) && components.has(b)) parent.set(find(b), find(a)); };
  const patterns = Object.fromEntries(Object.entries(policy.roles ?? {}).map(([key, values]) => [key, values.map(value => new RegExp(value, 'i'))]));
  const matches = (kind, ref) => (patterns[kind] ?? []).some(re => re.test(components.get(ref)?.role ?? ''));
  const sources = [], inferredLinks = [], roots = new Set();
  const record = (kind, refs, source, extra = {}) => sources.push({ kind, refs, source, ...extra });
  const powerNets = new Set(model.contract.nets.filter(n => ['power', 'ground'].includes(n.kind)).map(n => n.name));
  const refsByNet = new Map(model.contract.nets.map(n => [n.name, [...new Set(n.endpoints.map(e => e.component).filter(r => components.has(r)))]]));
  const membership = new Map(model.contract.blocks.flatMap(b => b.components.map(ref => [ref, b.id])));
  const features = new Map((model.config.componentFeatures ?? []).map(f => [f.ref, f]));
  const mechanical = new Set([...components.keys()].filter(ref => features.get(ref)?.edge || model.fixed.has(ref) || matches('mechanical', ref)));
  const relations = model.contract.extensions?.pcbLayout?.relations ?? [];
  for (const relation of relations) {
    if (!(policy.localRelationKinds ?? ['bypass', 'bootstrap', 'power-path']).includes(relation.kind)) continue;
    const a = relation.to.ref, b = relation.from.ref;
    if (!components.has(a) || !components.has(b)) continue;
    roots.add(a); join(a, b);
    record('typed-local-core', [a, b], 'Contract.extensions.pcbLayout.relations/' + relation.id, { relationKind: relation.kind });
  }
  const stopWords = new Set(policy.roleStopWords ?? []);
  const tokens = ref => ((components.get(ref)?.role ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2 && !stopWords.has(w));
  for (const [ref, component] of components) {
    if (component.pins?.length !== 2 || !matches('bypass', ref) || relations.some(r => r.from.ref === ref)) continue;
    const options = [...components].filter(([r, c]) => r !== ref && c.pins?.length > 2).map(([r]) => ({ ref: r, overlap: tokens(ref).filter(w => tokens(r).includes(w)).length }))
      .filter(v => v.overlap >= (policy.minimumRoleOverlap ?? 2)).sort((a, b) => b.overlap - a.overlap || a.ref.localeCompare(b.ref));
    const target = options[0]; if (!target) continue;
    const common = model.contract.nets.filter(n => n.kind === 'power' && n.endpoints.some(e => e.component === ref) && n.endpoints.some(e => e.component === target.ref));
    if (common.length !== 1) continue;
    const net = common[0], from = net.endpoints.find(e => e.component === ref), to = net.endpoints.find(e => e.component === target.ref);
    const pads = (owner, pin) => model.pads.filter(p => p.owner === owner && String(p.number) === String(pin)).map(p => ({ ref: owner, id: p.id }));
    const left = pads(ref, from.pin), right = pads(target.ref, to.pin); if (!left.length || !right.length) continue;
    roots.add(target.ref); join(target.ref, ref);
    const source = ['Contract.components/' + ref + '/role', 'Contract.components/' + target.ref + '/role', 'Contract.nets/' + net.name];
    inferredLinks.push({ id: 'role-bypass-' + ref, kind: 'bypass', from: { ref, pin: from.pin }, to: { ref: target.ref, pin: to.pin }, net: net.name, left, right, source });
    record('role-local-core', [target.ref, ref], source, { relationKind: 'bypass' });
  }
  const connectors = [...mechanical].filter(ref => matches('connector', ref));
  for (const ref of connectors) { roots.add(ref); record('mechanical-anchor', [ref], ['componentFeatures/' + ref + '/edge', 'Contract.components/' + ref + '/role']); }
  for (const ref of components.keys()) if (matches('protection', ref)) {
    const peers = connectors.map(r => ({ ref: r, count: [...refsByNet].filter(([n, rs]) => !powerNets.has(n) && rs.includes(ref) && rs.includes(r)).length })).sort((a, b) => b.count - a.count);
    if (peers[0]?.count >= (policy.minimumInterfaceSignals ?? 2)) { roots.add(ref); join(peers[0].ref, ref); record('interface-protection', [peers[0].ref, ref], 'Contract.nets/non-power-interface-endpoints'); }
  }
  for (const group of model.spatialRules.localGroups ?? []) {
    const refs = group.refs.filter(r => components.has(r));
    for (const ref of refs.slice(1)) join(refs[0], ref);
    record('declared-local-group', refs, 'spatial.localGroups/' + group.id);
  }
  const directRoots = ref => {
    const peers = new Map();
    for (const [net, refs] of refsByNet) if (!powerNets.has(net) && refs.includes(ref)) for (const r of refs) if (r !== ref && roots.has(r)) peers.set(find(r), r);
    return peers;
  };
  const sharedBus = [...components].filter(([ref, c]) => c.pins?.length === 2 && !roots.has(ref) && !mechanical.has(ref) && matches('sharedBus', ref)
    && [...refsByNet].some(([n, rs]) => !powerNets.has(n) && rs.includes(ref) && new Set(rs.filter(r => roots.has(r)).map(find)).size >= (policy.minimumBusRootGroups ?? 3))).map(([ref]) => ref);
  for (const ref of sharedBus.slice(1)) join(sharedBus[0], ref);
  for (const ref of sharedBus) record('shared-bus-exception', [ref], 'Contract.nets/endpoints');
  const assigned = ref => [...roots].some(r => find(r) === find(ref));
  const signalCount = ref => [...refsByNet].filter(([n, rs]) => !powerNets.has(n) && rs.includes(ref)).length;
  const weights = policy.associationWeights ?? { direct: 1, block: 1, role: 0 };
  for (const [key, value] of Object.entries(weights)) if (!['direct', 'block', 'role'].includes(key) || !Number.isFinite(value) || value < 0) throw Error('INVALID_SEMANTIC_ASSOCIATION_WEIGHT ' + key);
  const unresolved = [];
  for (const [ref, c] of components) {
    if (assigned(ref) || sharedBus.includes(ref) || mechanical.has(ref) || (model.spatialRules.localGroups ?? []).some(g => g.refs.includes(ref))) continue;
    const direct = directRoots(ref);
    const adc = [...roots].filter(r => matches('adcRoot', r));
    if (matches('adcAuxiliary', ref) && adc.length === 1) { join(adc[0], ref); record('role-front-end', [adc[0], ref], 'Contract.components/role'); continue; }
    const mechanicalPeers = [...mechanical].filter(r => !roots.has(r) && [...refsByNet].some(([n, rs]) => !powerNets.has(n) && rs.includes(ref) && rs.includes(r)));
    if (!direct.size && mechanicalPeers.length === 1) { join(mechanicalPeers[0], ref); record('mechanical-control-auxiliary', [mechanicalPeers[0], ref], 'Contract.nets/endpoints'); continue; }
    if (c.pins?.length === 2 && signalCount(ref) >= 2 && direct.size === 2) {
      const key = JSON.stringify([...direct.keys()].sort());
      const members = [...components].filter(([r, v]) => v.pins?.length === 2 && !mechanical.has(r) && !assigned(r) && signalCount(r) >= 2 && JSON.stringify([...directRoots(r).keys()].sort()) === key).map(([r]) => r);
      for (const r of members.slice(1)) join(members[0], r);
      record('inter-block-series-bridge', members, 'Contract.nets/endpoints'); continue;
    }
    const candidates = [...roots].map(r => ({ ref: r, score: (direct.has(find(r)) ? weights.direct ?? 0 : 0) + (membership.get(r) && membership.get(r) === membership.get(ref) ? weights.block ?? 0 : 0) + tokens(ref).filter(w => tokens(r).includes(w)).length * (weights.role ?? 0) }))
      .filter(v => v.score > 0).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
    if (candidates[0]) { join(candidates[0].ref, ref); record('declared-block-or-net-association', [candidates[0].ref, ref], ['Contract.blocks/' + membership.get(ref), 'Contract.nets/endpoints', 'Contract.components/' + ref + '/role']); }
    else unresolved.push(ref);
  }
  const byGroup = new Map(); for (const ref of components.keys()) { const id = find(ref); if (!byGroup.has(id)) byGroup.set(id, []); byGroup.get(id).push(ref); }
  const groups = [...byGroup.values()].map(refs => refs.sort()).sort((a, b) => a[0].localeCompare(b[0])).map((refs, i) => {
    refs.sort(); const anchors = [...roots].filter(r => refs.includes(r)), relevant = sources.filter(s => s.refs.some(r => refs.includes(r)));
    const kinds = relevant.flatMap(s => s.relationKind ? [s.relationKind] : []);
    const typedWeight = kinds.reduce((sum, kind) => sum + (model.config.comparisonWeights[kind === 'power-path' ? 'power' : 'bypass'] ?? 0), 0);
    const auxiliaryCount = Math.max(0, refs.length - kinds.length - Math.max(1, anchors.length));
    const weight = typedWeight + (model.config.comparisonWeights.connectivity ?? 0) * auxiliaryCount || (model.config.comparisonWeights.connectivity ?? 0) * refs.length;
    const geometry = refs.map(r => model.referenceGeometry.get(r));
    return { id: 'physical-' + String(i + 1).padStart(2, '0'), label: anchors.join('+') || refs[0], members: refs, anchors, type: 'flexible', weight,
      referenceMil: Math.max(Math.sqrt(geometry.reduce((sum, r) => sum + r.areaMil2, 0)), ...geometry.map(r => r.longMil)), sourceRules: relevant, mechanicalMembers: refs.filter(r => mechanical.has(r)), existingLimitUnchanged: true };
  });
  const total = groups.filter(g => g.members.length > 1).reduce((sum, g) => sum + g.weight, 0);
  for (const group of groups) group.normalizedWeight = total && group.members.length > 1 ? group.weight / total : 0;
  const groupByRef = new Map(groups.flatMap(g => g.members.map(r => [r, g.id])));
  const edges = model.contract.nets.filter(n => !powerNets.has(n.name)).map(n => ({ net: n.name, groups: [...new Set(n.endpoints.map(e => groupByRef.get(e.component)).filter(Boolean))], source: 'Contract.nets/' + n.name })).filter(e => e.groups.length > 1);
  return { schemaVersion: 1, kind: 'flitrealize.pcb-semantic-conversion', groups, interGroupEdges: edges, inferredLinks, unresolvedRoles: unresolved, sourceHash: model.snapshot.sourceHash, sourceRules: sources,
    policy: { hardRules: 'unchanged', groups: 'flexible soft compactness; no new fixed relative positions or distance caps', roleHeuristics: policy.roles ?? {}, associationWeights: weights, initialization: 'no placement hints or existing-position preference' }, hash: hash({ groups, edges, inferredLinks }) };
}

export function semanticGroupMetrics(semantic, plan) {
  const poses = new Map(plan.components.map(c => [c.ref, c]));
  return semantic.groups.map(group => {
    const boxes = group.members.map(ref => poses.get(ref)?.body); if (boxes.some(b => !b)) throw Error('SEMANTIC_PLAN_MEMBERSHIP ' + group.id);
    const widthMil = Math.max(...boxes.map(b => b.maxX)) - Math.min(...boxes.map(b => b.minX));
    const heightMil = Math.max(...boxes.map(b => b.maxY)) - Math.min(...boxes.map(b => b.minY));
    return { id: group.id, members: group.members, widthMil, heightMil, normalizedCompactness: (widthMil + heightMil) / group.referenceMil, weight: group.normalizedWeight };
  });
}
