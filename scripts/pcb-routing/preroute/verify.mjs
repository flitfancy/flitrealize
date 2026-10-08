import { conductiveGap, conductiveContact, outsidePadSegments } from '../geometry.mjs';
import { validatePrerouteInput, validateCandidate, routingConfig, wireShape, viaShape, boxShape, shapeBounds } from './schema.mjs';
import { copperIslands } from './prepare.mjs';

/** Independent continuous-geometry acceptance of additions; never writes native EDA data. */
export function verifyPreroute({ input, candidate }) {
  // Historical whole-copper candidates can carry stale component copper IDs;
  // independent verification rebuilds islands and never trusts that graph.
  validatePrerouteInput(input, { requireComponentCopper: false }); validateCandidate(candidate, input);
  const { routing, via } = routingConfig(input), tolerance = input.verification?.toleranceMil ?? 0.02;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('PREROUTE_INPUT:verification.toleranceMil');
  const clearance = input.clearanceMil, issues = [], warnings = [];
  const oldIds = new Set([...input.pads, ...input.segments, ...input.vias].map(o => o.id));
  for (const row of [...candidate.segments, ...candidate.vias]) if (oldIds.has(row.id)) issues.push({ code: 'DUPLICATE_COPPER_ID', id: row.id });
  const additions = [...candidate.segments.map(s => ({ ...s, shape: wireShape(s) })), ...candidate.vias.map(v => ({ ...v, shape: viaShape(v) }))];
  const old = [...input.pads.flatMap(p => p.shapes.map(shape => ({ id: p.id, net: p.net, shape }))),
    ...input.segments.map(s => ({ ...s, shape: wireShape(s) })), ...input.vias.map(v => ({ ...v, shape: viaShape(v) }))];
  const sensitive = new Set(input.nets.filter(n => n.sensitive).map(n => n.net)), noise = new Set(input.noiseNets ?? []);
  const isSensitivePair = (a, b) => sensitive.has(a) && noise.has(b) || sensitive.has(b) && noise.has(a);
  const hardSensitive = input.minimumSensitiveToSwitchMil ?? clearance, preferredSensitive = input.preferredSensitiveToSwitchMil ?? hardSensitive;
  let minimum = Infinity, sensitiveMinimum = Infinity;
  const escapeGroups = new Map();
  const declaredWidths = input.verification?.enforceDeclaredWidths === true;
  if (declaredWidths) for (const s of candidate.segments) {
    const rule = input.nets.find(n => n.net === s.net);
    if (!rule) continue;
    const samePads = (a, b) => a.length === b.length && a.every(id => b.includes(id));
    const component = s.bridgeComponentPadIds ? rule.components.find(c => samePads(c.pads, s.bridgeComponentPadIds)) : undefined;
    if (s.bridgeComponentPadIds && !component) issues.push({ code: 'BRIDGE_COMPONENT', id: s.id });
    const request = s.sourcePadId ? input.fanoutRequests?.find(r => r.padId === s.sourcePadId) : undefined;
    const allowedWidths = s.kind === 'bounded-power-escape' ? [rule.localWidthMil]
      : s.kind === 'planned-interface-escape' && request ? [request.widthMil ?? rule.localWidthMil]
      : component ? [component.widthMil] : [rule.widthMil, ...rule.components.map(c => c.widthMil)];
    if (!allowedWidths.some(width => Math.abs(s.width - width) <= tolerance)) issues.push({ code: 'DECLARED_WIDTH', id: s.id, widthMil: s.width, allowedWidthsMil: allowedWidths });
    if (component?.allowedLayers && !component.allowedLayers.includes(s.layer)) issues.push({ code: 'COMPONENT_LAYER', id: s.id });
  }
  for (const s of candidate.segments.filter(s => s.kind === 'bounded-power-escape')) {
    const pad = input.pads.find(p => p.id === s.escapePadId), rule = input.nets.find(n => n.net === s.net);
    if (!pad || pad.net !== s.net || !rule || Math.abs(s.width - rule.localWidthMil) > tolerance) issues.push({ code: 'INVALID_ESCAPE', id: s.id });
    const key = s.escapeGroupId ?? `${s.net}|${s.escapePadId}`;
    if (!escapeGroups.has(key)) escapeGroups.set(key, []); escapeGroups.get(key).push(s);
  }
  for (const [key, segments] of escapeGroups) {
    const pad = input.pads.find(p => p.id === segments[0].escapePadId), rule = input.nets.find(n => n.net === segments[0].net);
    if (!pad || !rule) continue;
    const outside = segments.flatMap(s => outsidePadSegments(s, pad)).reduce((sum, s) => sum + Math.hypot(s.x2 - s.x1, s.y2 - s.y1), 0);
    if (outside > (rule.escapeMaxOutsideMil ?? routing.escapeMaxOutsideMil) + tolerance) issues.push({ code: 'ESCAPE_TOO_LONG', key, outsideMil: outside });
  }
  for (let i = 0; i < additions.length; i++) {
    const a = additions[i], rule = input.nets.find(n => n.net === a.net);
    if (!rule) issues.push({ code: 'UNDECLARED_NET', id: a.id, net: a.net });
    if (rule?.allowedLayers && !a.shape.layers.every(l => rule.allowedLayers.includes(l))) issues.push({ code: 'NET_LAYER', id: a.id });
    for (const b of [...old, ...additions.slice(i + 1)]) {
      if (a.net === b.net) continue;
      const gap = conductiveGap(a.shape, b.shape); minimum = Math.min(minimum, gap);
      if (gap < clearance - tolerance) issues.push({ code: 'COPPER_CLEARANCE', a: a.id, b: b.id, gapMil: gap });
      if (isSensitivePair(a.net, b.net)) {
        sensitiveMinimum = Math.min(sensitiveMinimum, gap);
        if (gap < hardSensitive - tolerance) issues.push({ code: 'SENSITIVE_MINIMUM', a: a.id, b: b.id, gapMil: gap });
        else if (gap < preferredSensitive - tolerance) warnings.push({ code: 'SENSITIVE_TARGET', a: a.id, b: b.id, gapMil: gap });
      }
    }
    for (const k of input.keepouts ?? []) if (conductiveGap(a.shape, k.shape) < 0) issues.push({ code: 'KEEP_OUT', a: a.id, region: k.id });
    for (const f of input.fanouts ?? []) if (a.net !== f.net && conductiveGap(a.shape, boxShape(f.bbox, f.layers)) < 0) issues.push({ code: 'FANOUT_SPACE', a: a.id, region: f.id });
    const b = shapeBounds(a.shape), edge = input.copperEdgeMil;
    if (b.minX < edge - 0.0001 || b.minY < edge - 0.0001 || b.maxX > input.boardMil[0] - edge + 0.0001 || b.maxY > input.boardMil[1] - edge + 0.0001) issues.push({ code: 'BOARD_EDGE', a: a.id });
  }
  for (const v of candidate.vias) {
    if (Math.abs(v.diameter - via.diameterMil) > tolerance || Math.abs(v.hole - via.holeMil) > tolerance) issues.push({ code: 'VIA_SIZE', id: v.id });
    const drill = { ...viaShape(v), radius: v.hole / 2 };
    for (const p of input.pads) {
      // Exceptions are explicit input evidence, never inferred from source pad or net identity.
      const exception = (input.verification?.viaInPadExceptions ?? []).find(e => e.viaId === v.id && e.padId === p.id && e.confirmed === true);
      if (!exception && p.shapes.some(sh => conductiveGap(drill, sh) < via.drillPadClearanceMil - tolerance)) issues.push({ code: 'DRILL_PAD', id: v.id, pad: p.id });
    }
  }
  const allVias = [...input.vias, ...candidate.vias];
  for (const v of candidate.vias) for (const w of allVias) if (v !== w && Math.hypot(v.x - w.x, v.y - w.y) < via.drillCenterSpacingMil - tolerance) issues.push({ code: 'DRILL_SPACING', a: v.id, b: w.id });
  const connectivity = input.nets.map(n => {
    const selectedPads = input.pads.filter(p => p.net === n.net);
    const islands = copperIslands({ net: n.net, pads: input.pads, segments: [...input.segments, ...candidate.segments], vias: allVias, layers: routing.layerIds });
    return { net: n.net, connected: selectedPads.length > 0 && islands.length === 1, pads: selectedPads.length, wasConnected: n.baselineConnected,
      disconnected: islands.slice(1).flatMap(c => Object.entries(c).flatMap(([role, ids]) => ids.map(id => ({ role, id })))) };
  });
  for (const n of candidate.nets ?? []) if (['candidate-connected', 'preserved-connected'].includes(n.status) && !connectivity.find(c => c.net === n.net)?.connected) issues.push({ code: 'CONNECTIVITY_CLAIM', net: n.net });
  // Each completed explicit fanout must have source-pad contact in continuous geometry.
  for (const row of candidate.records ?? []) if (row.status === 'escape-and-via-planned') {
    const pad = input.pads.find(p => p.id === row.padId), ss = candidate.segments.filter(s => s.sourcePadId === row.padId);
    if (!pad || !ss.some(s => pad.contactShapes.some(sh => conductiveContact(wireShape(s), sh)))) issues.push({ code: 'FANOUT_SOURCE_CONTACT', padId: row.padId });
  }
  return { status: issues.length ? 'failed' : 'independently-verified', issues, warnings, connectivity,
    toleranceMil: tolerance,
    baselineConnected: connectivity.filter(n => n.wasConnected).length, nowConnected: connectivity.filter(n => n.connected).length,
    remaining: connectivity.filter(n => !n.connected).map(n => n.net),
    minimumNewCopperGapMil: Number.isFinite(minimum) ? minimum : null,
    minimumSensitiveToSwitchMil: Number.isFinite(sensitiveMinimum) ? sensitiveMinimum : null,
    addedSegments: candidate.segments.length, addedVias: candidate.vias.length,
    declaredWidthPolicyVerified: declaredWidths && !issues.some(i => ['DECLARED_WIDTH', 'BRIDGE_COMPONENT', 'COMPONENT_LAYER', 'INVALID_ESCAPE', 'ESCAPE_TOO_LONG'].includes(i.code)),
    delegatedNets: input.delegatedNets ?? [],
    scope: 'independent geometry/connectivity of supplied signal and power copper; delegated ground-plane nets and local current/impedance/return performance require separate verification',
    groundVerified: false, powerLocalCurrentCapabilityVerified: false, usbImpedanceVerified: false,
    nativeWrites: 0, nativeDrcRun: false };
}
