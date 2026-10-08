import { createHash } from 'node:crypto';
import { connectivityIslands } from '../geometry.mjs';
import { shapeBounds, DEFAULT_ROUTING, DEFAULT_VIA, validatePrerouteInput } from './schema.mjs';
import {normalizePrerouteGeometry} from './layout-geometry.mjs';

/** Group the actual copper into islands. No reference-name or net-name role inference. */
export function copperIslands({ net, pads, segments, vias, layers }) {
  return connectivityIslands(net, pads, segments, vias, { layers });
}
function selectorMatches(selector, component, padById) {
  if (selector.padIds?.some(id => component.pads.includes(id))) return true;
  if (selector.owners?.some(owner => component.pads.some(id => padById.get(id).owner === owner))) return true;
  return selector.all === true;
}
function componentRules(rule, config, component, padById) {
  const branches = config.branches ?? [];
  if (!Array.isArray(branches)) throw new Error(`PREROUTE_PREPARE:branches-must-be-array:${rule.net}`);
  const fallbacks = branches.map((branch, index) => ({ branch, index })).filter(({ branch }) => branch.all === true);
  if (fallbacks.length > 1) throw new Error(`PREROUTE_PREPARE:multiple-fallback-branches:${rule.net}`);
  if (fallbacks.some(({ branch }) => branch.padIds?.length || branch.owners?.length)) throw new Error(`PREROUTE_PREPARE:all-selector-is-fallback-only:${rule.net}`);
  const resolved = (branch, index, source) => ({ role: branch.role ?? config.role ?? 'ordinary_signal',
    widthMil: branch.widthMil ?? rule.defaultWireWidthMil,
    ...((branch.allowedLayers ?? config.allowedLayers ?? rule.primaryAutoLayers) ? { allowedLayers: [...(branch.allowedLayers ?? config.allowedLayers ?? rule.primaryAutoLayers)] } : {}),
    declarationIndex: index, source });
  const signature = r => JSON.stringify([r.widthMil, r.role, r.allowedLayers?.slice().sort((a, b) => a - b)]);
  const assignments = new Map();
  for (const padId of component.pads) {
    const explicit = branches.map((branch, index) => ({ branch, index }))
      .filter(({ branch }) => branch.all !== true && selectorMatches(branch, { pads: [padId] }, padById));
    const choices = explicit.map(({ branch, index }) => resolved(branch, index, 'explicit-branch'));
    if (new Set(choices.map(signature)).size > 1) throw new Error(`PREROUTE_PREPARE:conflicting-pad-branch:${rule.net}:${padId}`);
    const chosen = choices[0] ?? (fallbacks[0] ? resolved(fallbacks[0].branch, fallbacks[0].index, 'fallback-branch') : resolved({}, -1, 'net-default'));
    if (!assignments.has(chosen.declarationIndex)) assignments.set(chosen.declarationIndex, { ...chosen, padIds: [] });
    assignments.get(chosen.declarationIndex).padIds.push(padId);
  }
  const matchedRoles = [...assignments.values()].sort((a, b) => (a.declarationIndex < 0 ? Infinity : a.declarationIndex) - (b.declarationIndex < 0 ? Infinity : b.declarationIndex));
  // Distinct pad roles can share existing copper. Use the largest bridge width;
  // equal-width declarations retain policy order and all assignments stay visible.
  const bridge = matchedRoles.reduce((best, current) => current.widthMil > best.widthMil ? current : best);
  const sourcePadIds = component.pads.filter(id => config.sourcePadIds?.includes(id) || config.sourceOwners?.includes(padById.get(id).owner));
  return { widthMil: bridge.widthMil, role: bridge.role,
    ...(bridge.allowedLayers ? { allowedLayers: bridge.allowedLayers } : {}), matchedRoles,
    sourcePadIds, sourceOwners: [...new Set(sourcePadIds.map(id => padById.get(id).owner).filter(Boolean))],
    bridgeRuleSelection: 'maximum matched width; equal-width ties follow branch declaration order' };
}
/**
 * board: {boardMil,parts,pads,segments,vias,fanouts,keepouts}, or rendered {copper}.
 * policy: {nets:[{net,defaultWireWidthMil,preroute:{sourcePadIds,sourceOwners,
 *   localWidthMil,allowedLayers,pairedHold,branches:[{padIds|owners|all,widthMil,role,allowedLayers}]}}]}.
 * all:true is a single fallback for pads without an explicit padIds/owners match.
 * A copper island may contain distinct pad roles; its bridge uses the maximum width.
 * Geometry is already in mil. Provider/native pad conversion belongs upstream.
 */
export function preparePrerouteInput({ board, policy, options = {} }) {
  if (!board || !policy || !Array.isArray(policy.nets)) throw new Error('PREROUTE_PREPARE:board-and-policy-required');
  for (const [name, source] of [['board', board], ['policy', policy]]) {
    if (source.units !== undefined && source.units !== 'mil') throw new Error(`PREROUTE_PREPARE:${name}.units-must-be-mil`);
  }
  const normalized=normalizePrerouteGeometry(board,policy,options);board=normalized.board;policy=normalized.policy;
  const routingLayers = options.routing?.layerIds ?? policy.preroute?.routing?.layerIds ?? policy.layers?.map(layer => typeof layer === 'number' ? layer : layer.id) ?? DEFAULT_ROUTING.layerIds;
  const reservedLayers = new Set((policy.layers ?? []).filter(layer => typeof layer === 'object' && layer.signalRoutingAllowed === false).map(layer => layer.id));
  const defaultAllowedLayers = routingLayers.filter(layer => !reservedLayers.has(layer));
  const copper = board.copper ?? [];
  const pads = (board.pads ?? copper.filter(c => c.type === 'pad')).map(p => {
    const shape = p.shape ?? p.shapes?.[0];
    if (!shape) throw new Error(`PREROUTE_PREPARE:pad-shape:${p.id}`);
    const bbox = p.bbox ?? shapeBounds(shape);
    return { ...p, bbox, shape, shapes: p.shapes ?? [shape], contactShapes: p.contactShapes ?? [shape],
      x: p.x ?? (bbox.minX + bbox.maxX) / 2, y: p.y ?? (bbox.minY + bbox.maxY) / 2 };
  });
  const segments = (board.segments ?? copper.filter(c => c.type === 'wire').map(c => ({ ...c,
    layer: c.shape.layers[0], width: c.shape.radius * 2,
    x1: c.shape.a[0], y1: c.shape.a[1], x2: c.shape.b[0], y2: c.shape.b[1] }))).map(s => ({ ...s }));
  const vias = (board.vias ?? copper.filter(c => c.type === 'via').map(c => ({ ...c,
    x: c.shape.center[0], y: c.shape.center[1], diameter: c.shape.radius * 2,
    hole: c.hole ?? options.via?.holeMil, layers: c.shape.layers }))).map(v => ({ ...v }));
  const padById = new Map(pads.map(p => [p.id, p]));
  const delegatedNets = policy.nets.filter(rule => rule.roles?.some(role => role.name === 'ground_plane') || rule.preroute?.exclude)
    .map(rule => ({ net: rule.net, status: rule.roles?.some(role => role.name === 'ground_plane') ? 'delegated-ground-plane' : 'excluded-by-policy' }));
  const nets = policy.nets.filter(rule => !delegatedNets.some(row => row.net === rule.net)).map(rule => {
    const declared = rule.preroute ?? {};
    for (const layers of [rule.primaryAutoLayers, ...((rule.roles ?? []).map(role => role.allowedLayers)), declared.allowedLayers, ...((declared.branches ?? []).map(branch => branch.allowedLayers))].filter(Boolean)) {
      if (!Array.isArray(layers)) throw new Error(`PREROUTE_PREPARE:allowed-layers-array:${rule.net}`);
      if (layers.some(layer => routingLayers.includes(layer) && reservedLayers.has(layer))) throw new Error(`PREROUTE_PREPARE:reserved-auto-routing-layer:${rule.net}`);
    }
    const allowedLayers = declared.allowedLayers ?? rule.primaryAutoLayers ?? defaultAllowedLayers;
    if (!allowedLayers.length) throw new Error(`PREROUTE_PREPARE:no-auto-routing-layers:${rule.net}`);
    const config = { ...declared, allowedLayers };
    const islands = copperIslands({ net: rule.net, pads, segments, vias, layers: routingLayers });
    const components = islands.filter(c => c.pads.length).map(c => {
      return { ...c, owners: [...new Set(c.pads.map(id => padById.get(id).owner).filter(Boolean))],
        ...componentRules(rule, config, c, padById) };
    });
    const sourceSpecified = config.sourcePadIds?.length || config.sourceOwners?.length;
    const sources = components.map((c, i) => selectorMatches({ padIds: config.sourcePadIds, owners: config.sourceOwners }, c, padById) ? i : -1).filter(i => i >= 0);
    if (sourceSpecified && sources.length !== 1) throw new Error(`PREROUTE_PREPARE:source-must-identify-one-island:${rule.net}`);
    // Largest existing island is a neutral tree seed when no electrical source was declared.
    const rootIndex = components.length ? (sources[0] ?? components.reduce((best, c, i) => c.pads.length > components[best].pads.length ? i : best, 0)) : -1;
    return { net: rule.net, priority: config.priority ?? rule.priority ?? 0,
      sensitive: config.sensitive ?? rule.roles?.some(r => r.name === 'sensitive_signal') ?? false,
      widthMil: rule.defaultWireWidthMil, localWidthMil: config.localWidthMil ?? rule.defaultWireWidthMil,
      ...(config.escapeMaxOutsideMil !== undefined ? { escapeMaxOutsideMil: config.escapeMaxOutsideMil } : {}),
      allowedLayers: config.allowedLayers,
      sourcePadIds: config.sourcePadIds ?? [], sourceOwners: config.sourceOwners ?? [],
      components, rootIndex, baselineConnected: components.length > 0 && islands.length === 1, pairedHold: config.pairedHold ?? false };
  });
  const fanoutStates = (board.fanouts ?? options.fanouts ?? []).map(f => {
    if (!f.padId) throw new Error(`PREROUTE_PREPARE:fanout-padId-required:${f.id}`);
    const pad = padById.get(f.padId), net = nets.find(n => n.net === f.net), component = net?.components.find(c => c.pads.includes(f.padId));
    if (!pad || pad.net !== f.net) throw new Error(`PREROUTE_PREPARE:fanout-pad-mismatch:${f.id}`);
    return { ...f, active: f.active ?? (!!component && component.pads.length === 1 && !component.wires.length && !component.vias.length) };
  });
  const input = { schemaVersion: 1, units: 'mil', boardMil: board.boardMil ?? options.boardMil,
    parts: board.parts ?? [], pads, segments, vias, keepouts: board.keepouts ?? [],
    fanouts: fanoutStates.filter(f => f.active), fanoutStates, nets, delegatedNets,
    clearanceMil: options.clearanceMil ?? policy.clearances?.ordinaryCopperMil ?? policy.clearances?.minimumCopperMil ?? 6,
    copperEdgeMil: options.copperEdgeMil ?? policy.copperEdgeMil ?? policy.preroute?.copperEdgeMil ?? 0,
    minimumSensitiveToSwitchMil: options.minimumSensitiveToSwitchMil ?? policy.clearances?.minimumSensitiveToSwitchCopperMil,
    preferredSensitiveToSwitchMil: options.preferredSensitiveToSwitchMil ?? policy.clearances?.sensitiveToSwitchCopperTargetMil,
    noiseNets: options.noiseNets ?? policy.noiseNets ?? policy.preroute?.noiseNets ?? [], gridMil: options.gridMil ?? policy.preroute?.gridMil ?? 2,
    via: options.via ?? policy.via ?? policy.preroute?.via ?? { ...DEFAULT_VIA },
    routing: { ...(policy.layers ? { layerIds: policy.layers.map(l => typeof l === 'number' ? l : l.id) } : {}), ...policy.preroute?.routing, ...options.routing },
    fanoutRequests: options.fanoutRequests ?? [], diagnostics: options.diagnostics ?? {}, ground: options.ground ?? {},
    verification: { enforceDeclaredWidths: true, ...options.verification }, nativeWrites: 0,
    ruleCoverage: { layerPermissionsSource: 'policy.layers[].signalRoutingAllowed', reservedAutoRoutingLayers: [...reservedLayers], mainViaTransitionTopologyVerified: false, mainViaTransitionBackend: 'FR' },
    baselineCandidateHash: createHash('sha256').update(JSON.stringify(board)).digest('hex'),
    layerMapping: normalized.layerMapping,
    scope: 'offline two-layer signal/power search; delegated ground-plane nets require a separate potential-space study and native pour verification',
    searchAssumptions: { defaultsAreSearchParametersNotFabricationApproval: true,
      clearanceDefaulted: options.clearanceMil === undefined && policy.clearances?.ordinaryCopperMil === undefined && policy.clearances?.minimumCopperMil === undefined,
      copperEdgeDefaulted: options.copperEdgeMil === undefined && policy.copperEdgeMil === undefined && policy.preroute?.copperEdgeMil === undefined,
      viaDefaulted: options.via === undefined && policy.via === undefined && policy.preroute?.via === undefined } };
  return validatePrerouteInput(input);
}
