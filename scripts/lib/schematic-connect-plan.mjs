import { readFile } from 'node:fs/promises';

// Reuse the existing host Action; this module never receives an EDA instance.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wireAction = new AsyncFunction('eda', 'flitrealizeInput',
  await readFile(new URL('../actions/schematic-wire-plan.js', import.meta.url), 'utf8'));

const text = value => typeof value === 'string' ? value.trim() : '';
const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const keyFor = (designator, pin) => `${designator}.${pin}`;
function points(value) {
  if (!Array.isArray(value)) return [];
  if (value.every(Number.isFinite)) {
    if (value.length % 2) return [];
    return Array.from({ length: value.length / 2 }, (_, i) => ({ x: value[i * 2], y: value[i * 2 + 1] }));
  }
  const normalized = value.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p);
  return normalized.every(point) ? normalized : [];
}
function segmentDistance(p, a, b) {
  const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length)) : 0;
  return distance(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
}
function touches(p, path, tolerance) {
  return point(p) && path.some((a, i) => distance(p, a) <= tolerance || (path[i + 1] && segmentDistance(p, a, path[i + 1]) <= tolerance));
}
function intersects(a, b, c, d, tolerance) {
  if ([segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b)].some(v => v <= tolerance)) return true;
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
function pathsTouch(a, b, tolerance) {
  return a.some((p, i) => a[i + 1] && b.some((q, j) => b[j + 1] && intersects(p, a[i + 1], q, b[j + 1], tolerance)));
}

/**
 * Deterministic, read-only planning for isolated endpoint stubs. The returned
 * pending lists are safe to apply only when applyReady is true. Every live pin
 * in scope must be classified by a Contract net or an explicit NC declaration.
 * Existing general routing is deliberately not inferred from matching names.
 */
export async function planConnections(input, snapshot, { phase = 'plan' } = {}) {
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const issue = (code, message, details = {}) => {
    const diagnostic = { severity: 'error', code, message, ...details };
    const key = JSON.stringify(diagnostic);
    if (!diagnosticKeys.has(key)) { diagnosticKeys.add(key); diagnostics.push(diagnostic); }
  };
  const contract = input?.contract;
  const strategy = input?.strategy ?? 'endpoint-stubs';
  const stubLength = input?.stubLength ?? 8;
  const grid = input?.grid ?? 1;
  const tolerance = input?.connectionTolerance ?? input?.tolerance ?? 0.1;
  const flagItems = [], missingFlagItems = [], noConnectItems = [], pendingNoConnectItems = [], endpointEvidence = [];
  let wirePlan = null;
  const scope = { fullDocument: !Array.isArray(input?.designators), completeContract: false, designators: [], deferredComponents: [], excludedLiveDesignators: [], actualPinCount: 0, classifiedPinCount: 0 };
  const result = () => {
    const pending = { wires: wirePlan?.wires?.length ?? 0, flags: missingFlagItems.length, noConnect: pendingNoConnectItems.length };
    return { schemaVersion: 1, kind: 'flitrealize.schematic-connect-plan', strategy, phase, scope,
      wirePlan, wireItems: wirePlan?.wires ?? [], flagItems, missingFlagItems, noConnectItems, pendingNoConnectItems,
      endpointEvidence, pending, diagnostics, applyReady: diagnostics.length === 0,
      verified: diagnostics.length === 0 && Object.values(pending).every(count => count === 0) };
  };
  if (!['plan', 'verify'].includes(phase)) issue('INVALID_PHASE', 'phase must be plan or verify.');
  if (strategy !== 'endpoint-stubs') issue('STRATEGY_UNSUPPORTED', 'This entry supports isolated endpoint stubs only.');
  if (!contract || contract.kind !== 'flitrealize.schematic-contract' || contract.schemaVersion !== 1 || !Array.isArray(contract.components) || !Array.isArray(contract.nets)) issue('INVALID_CONTRACT', 'A SchematicContract v1 with components and nets is required.');
  if (!snapshot || snapshot.kind !== 'flitrealize.schematic-snapshot' || snapshot.schemaVersion !== 1 || snapshot.provider !== 'easyeda-pro' || !Array.isArray(snapshot.components)) issue('INVALID_SNAPSHOT', 'A live EasyEDA SchematicSnapshot v1 is required.');
  if (!Number.isFinite(stubLength) || stubLength <= 0 || stubLength > 1000 || !Number.isFinite(grid) || grid <= 0 || grid > 100 || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) issue('INVALID_GEOMETRY_OPTIONS', 'Invalid stubLength, grid, or connectionTolerance.');
  if (diagnostics.length) return result();
  if (!text(input.expectedDocumentUuid) || !text(input.expectedProjectUuid)) issue('TARGET_IDENTITY_REQUIRED', 'expectedDocumentUuid and expectedProjectUuid are required.');
  if (snapshot.document?.nativeId !== input.expectedDocumentUuid || snapshot.project?.nativeId !== input.expectedProjectUuid) issue('TARGET_MISMATCH', 'The live document or project differs from the requested target.');
  const provider = snapshot.extensions?.easyedaPro;
  if (provider?.sourceEvidence !== 'ok' || !text(provider.sourceFingerprint) || !Array.isArray(provider.markers) || !Array.isArray(provider.wires)) issue('CONNECTION_EVIDENCE_REQUIRED', 'Reinspect with includeConnectionEvidence:true before planning or verifying.');
  const contractByRef = new Map();
  for (const component of contract.components) {
    if (!text(component.designator) || contractByRef.has(component.designator)) issue('DUPLICATE_OR_EMPTY_CONTRACT_DESIGNATOR', 'Contract designators must be nonempty and unique.', { designator: component.designator });
    contractByRef.set(component.designator, component);
  }
  const actualParts = snapshot.components.filter(component => !['netflag', 'netport'].includes(component.extensions?.easyedaPro?.componentType));
  const liveByRef = new Map();
  for (const component of actualParts) {
    if (liveByRef.has(component.designator)) issue('DUPLICATE_SNAPSHOT_DESIGNATOR', 'A live designator is duplicated.', { designator: component.designator });
    liveByRef.set(component.designator, component);
  }
  if (input.designators !== undefined && (!Array.isArray(input.designators) || !input.designators.length || input.designators.some(ref => !text(ref)) || new Set(input.designators).size !== input.designators.length)) issue('INVALID_SCOPE', 'designators must be a nonempty, unique array when supplied.');
  const requested = new Set(Array.isArray(input.designators) ? input.designators : contractByRef.keys());
  for (const ref of requested) if (!contractByRef.has(ref)) issue('SCOPE_COMPONENT_UNKNOWN', 'Scope contains a component absent from Contract.', { designator: ref });
  const deferred = new Map();
  if (input.deferredComponents !== undefined && !Array.isArray(input.deferredComponents)) issue('INVALID_DEFERRALS', 'deferredComponents must be an array.');
  for (const item of Array.isArray(input.deferredComponents) ? input.deferredComponents : []) {
    if (!item || !requested.has(item.designator) || !text(item.reason) || deferred.has(item.designator) || liveByRef.has(item.designator)) {
      issue('INVALID_COMPONENT_DEFERRAL', 'A deferral needs a unique in-scope absent Contract component and an explicit reason.', { designator: item?.designator });
    } else deferred.set(item.designator, { designator: item.designator, reason: item.reason.trim() });
  }
  scope.deferredComponents = [...deferred.values()];
  scope.completeContract = scope.fullDocument && deferred.size === 0;
  scope.designators = [...requested].filter(ref => !deferred.has(ref));
  scope.excludedLiveDesignators = actualParts.map(c => c.designator).filter(ref => !requested.has(ref));
  if (scope.fullDocument) for (const ref of scope.excludedLiveDesignators) issue('UNDECLARED_LIVE_COMPONENT', 'Full-document completion requires every live component in Contract.', { designator: ref });
  const refs = new Set(scope.designators);
  const expectedPins = new Map();
  const setExpected = (ref, physicalPin, expectation) => {
    const key = keyFor(ref, physicalPin), previous = expectedPins.get(key);
    if (previous && (previous.noConnect !== expectation.noConnect || previous.net !== expectation.net)) {
      issue('PIN_INTENT_CONFLICT', 'One provider pin is assigned conflicting nets or both a net and NC.', { designator: ref, pin: physicalPin });
    } else if (previous && previous.semanticPin !== expectation.semanticPin) {
      issue('PIN_MAP_ALIAS_UNSUPPORTED', 'Multiple semantic pins map to the same physical pin; resolve the mapping before generating one stub per physical endpoint.', { designator: ref, pin: physicalPin });
    } else expectedPins.set(key, { designator: ref, pin: physicalPin, ...expectation });
  };
  const mapping = (component, semanticPin) => {
    const raw = component.bindings?.easyedaPro?.pinMap?.[String(semanticPin)] ?? [String(semanticPin)];
    const mapped = [...new Set((Array.isArray(raw) ? raw : [raw]).map(value => String(value).trim()).filter(Boolean))];
    if (!mapped.length) issue('PIN_MAP_EMPTY', 'A semantic pin maps to no provider pins.', { designator: component.designator, pin: String(semanticPin) });
    return mapped;
  };
  const semanticKeys = new Set();
  for (const ref of refs) {
    const component = contractByRef.get(ref), live = liveByRef.get(ref);
    if (!component) continue;
    if (!live) { issue('COMPONENT_NOT_REALIZED', 'A requested Contract component is absent; use an explicit reasoned deferral where intended.', { designator: ref }); continue; }
    if (!text(live.value)) issue('COMPONENT_VALUE_EMPTY', 'The realized component Value is empty.', { designator: ref });
    if (live.extensions?.easyedaPro?.pinInspection && live.extensions.easyedaPro.pinInspection !== 'ok') issue('PIN_INSPECTION_INCOMPLETE', 'Cannot classify pins from an incomplete live read.', { designator: ref });
    if (!Array.isArray(component.pins) || !component.pins.length || !Array.isArray(live.pins) || !live.pins.length) issue('PINS_UNAVAILABLE', 'Contract and live component both need complete pin lists.', { designator: ref });
    for (const pin of component.pins || []) {
      const semanticKey = keyFor(ref, pin.number);
      if (semanticKeys.has(semanticKey)) issue('DUPLICATE_CONTRACT_PIN', 'Contract pin numbers must be unique per component.', { designator: ref, pin: pin.number });
      semanticKeys.add(semanticKey);
      for (const physicalPin of mapping(component, pin.number)) {
        if (!(live.pins || []).some(p => String(p.number) === physicalPin)) issue('PIN_NOT_REALIZED', 'A mapped Contract pin is absent from the live symbol.', { designator: ref, pin: String(pin.number), providerPin: physicalPin });
        if (pin.classification === 'no-connect') setExpected(ref, physicalPin, { noConnect: true, net: null, semanticPin: String(pin.number), reason: 'Contract classification: no-connect' });
      }
    }
  }
  const netByName = new Map();
  for (const net of contract.nets) {
    if (!text(net.name) || netByName.has(net.name)) issue('DUPLICATE_OR_EMPTY_NET', 'Contract net names must be nonempty and unique.', { net: net.name });
    netByName.set(net.name, net);
    for (const endpoint of net.endpoints || []) {
      const declaredComponent = contractByRef.get(endpoint.component);
      if (!declaredComponent) issue('NET_COMPONENT_UNDECLARED', 'A Contract net endpoint refers to an undeclared component.', { designator: endpoint.component, pin: String(endpoint.pin), net: net.name });
      else if (!(declaredComponent.pins || []).some(pin => String(pin.number) === String(endpoint.pin))) issue('NET_PIN_UNDECLARED', 'A Contract net endpoint refers to an undeclared semantic pin.', { designator: endpoint.component, pin: String(endpoint.pin), net: net.name });
      if (!refs.has(endpoint.component)) continue;
      const component = contractByRef.get(endpoint.component);
      if (!component) continue;
      if (!semanticKeys.has(keyFor(endpoint.component, endpoint.pin))) issue('NET_PIN_UNDECLARED', 'A net endpoint is absent from Contract pin declarations.', { designator: endpoint.component, pin: String(endpoint.pin), net: net.name });
      for (const physicalPin of mapping(component, endpoint.pin)) setExpected(endpoint.component, physicalPin, { noConnect: false, net: net.name, semanticPin: String(endpoint.pin) });
    }
  }
  if (input.providerPinNoConnect !== undefined && !Array.isArray(input.providerPinNoConnect)) issue('INVALID_PROVIDER_NC', 'providerPinNoConnect must be an array.');
  const extraNcKeys = new Set();
  for (const item of Array.isArray(input.providerPinNoConnect) ? input.providerPinNoConnect : []) {
    if (!item || !refs.has(item.designator) || !text(String(item.pin ?? '')) || !text(item.reason)) { issue('INVALID_PROVIDER_NC', 'A verified provider-only NC pin requires an in-scope designator, pin, and reason.'); continue; }
    const pin = String(item.pin), key = keyFor(item.designator, pin), component = contractByRef.get(item.designator);
    if (extraNcKeys.has(key)) issue('DUPLICATE_PROVIDER_NC', 'Provider NC declarations must be unique.', { designator: item.designator, pin });
    extraNcKeys.add(key);
    if ((component?.pins || []).some(p => mapping(component, p.number).includes(pin))) issue('PROVIDER_NC_NOT_EXTRA', 'Use Contract classification for a mapped pin; providerPinNoConnect is only for verified extra physical pins.', { designator: item.designator, pin });
    if (!(liveByRef.get(item.designator)?.pins || []).some(p => String(p.number) === pin)) issue('PROVIDER_NC_PIN_MISSING', 'The declared provider-only pin is absent from the live symbol.', { designator: item.designator, pin });
    setExpected(item.designator, pin, { noConnect: true, net: null, reason: item.reason.trim() });
  }
  const liveWires = (provider?.wires || []).map(wire => ({ ...wire, points: points(wire.points ?? wire.line) }));
  const markers = provider?.markers || [];
  const seenWireIds = new Set();
  for (const wire of liveWires) {
    if (!text(wire.primitiveId) || seenWireIds.has(wire.primitiveId) || wire.points.length < 2) issue('WIRE_EVIDENCE_INVALID', 'Every live wire needs a unique primitive ID and readable geometry.', { wireId: wire.primitiveId ?? null });
    seenWireIds.add(wire.primitiveId);
  }
  const seenMarkerIds = new Set();
  for (const marker of markers) {
    if (!text(marker.primitiveId) || seenMarkerIds.has(marker.primitiveId) || !point(marker) || !text(marker.net)) issue('MARKER_EVIDENCE_INVALID', 'Every network marker needs a unique primitive ID, readable position, and network.', { markerId: marker.primitiveId ?? null });
    seenMarkerIds.add(marker.primitiveId);
  }
  const allPins = actualParts.flatMap(component => (component.pins || []).map(pin => ({ designator: component.designator, pin: String(pin.number), position: pin.position })));
  for (const ref of refs) {
    const seen = new Set();
    for (const pin of liveByRef.get(ref)?.pins || []) {
      const number = String(pin.number), key = keyFor(ref, number), expected = expectedPins.get(key);
      scope.actualPinCount += 1;
      if (seen.has(number)) issue('DUPLICATE_LIVE_PIN', 'The live symbol contains duplicate pin numbers.', { designator: ref, pin: number });
      seen.add(number);
      if (!expected) { issue('UNCLASSIFIED_LIVE_PIN', 'Every actual pin needs a Contract net or an explicit NC declaration.', { designator: ref, pin: number }); continue; }
      scope.classifiedPinCount += 1;
      if (!point(pin.position)) { issue('PIN_POSITION_UNRESOLVED', 'Cannot audit a pin without actual coordinates.', { designator: ref, pin: number }); continue; }
      if (typeof pin.noConnect !== 'boolean') issue('NC_STATE_UNKNOWN', 'A live noConnect Boolean is required.', { designator: ref, pin: number });
      const touching = liveWires.filter(wire => touches(pin.position, wire.points, tolerance));
      if (expected.noConnect) {
        const item = { designator: ref, pin: number, noConnected: true, reason: expected.reason };
        noConnectItems.push(item);
        if (pin.noConnect !== true) pendingNoConnectItems.push(item);
        if (touching.length || text(pin.net) || markers.some(marker => point(marker) && distance(marker, pin.position) <= tolerance)) issue('NC_PIN_CONNECTED', 'An intended NC pin touches wiring or a network marker.', { designator: ref, pin: number });
      } else {
        if (pin.noConnect === true) issue('NO_CONNECT_ENDPOINT', 'An intended net endpoint is already marked NC.', { designator: ref, pin: number, net: expected.net });
        if (text(pin.net) && pin.net !== expected.net) issue('PIN_NET_MISMATCH', 'The live pin reports a different network.', { designator: ref, pin: number, expectedNet: expected.net, actualNet: pin.net });
        if (touching.some(wire => wire.net !== expected.net)) issue('EXISTING_WIRE_NET_MISMATCH', 'A pin touches a conflicting or unnamed wire.', { designator: ref, pin: number, net: expected.net });
        if (touching.length > 1) issue('EXISTING_TOPOLOGY_UNSUPPORTED', 'An endpoint touches multiple wires; isolated-stub ownership is ambiguous.', { designator: ref, pin: number });
      }
    }
  }
  const scopedContract = { ...contract, components: contract.components.filter(component => refs.has(component.designator)),
    nets: contract.nets.map(net => ({ ...net, endpoints: (net.endpoints || []).filter(endpoint => refs.has(endpoint.component)) })).filter(net => net.endpoints.length) };
  try {
    wirePlan = (await wireAction(null, { mode: 'generate', contract: scopedContract, snapshot, stubLength, grid, connectionTolerance: tolerance })).wirePlan;
    // The Action timestamps creation; expose stable provenance for this pure planner.
    wirePlan.generatedAt = snapshot.capturedAt ?? '1970-01-01T00:00:00.000Z';
    for (const diagnostic of wirePlan.unresolved) issue(diagnostic.code, diagnostic.message, Object.fromEntries(Object.entries(diagnostic).filter(([key]) => !['code', 'message'].includes(key))));
  } catch (error) { issue(error.code ?? 'WIRE_PLAN_FAILED', error.message); }
  const candidateWires = [];
  for (const expected of expectedPins.values()) {
    if (expected.noConnect) continue;
    const component = liveByRef.get(expected.designator), pin = component?.pins?.find(p => String(p.number) === expected.pin);
    if (!point(pin?.position)) continue;
    const matching = liveWires.filter(wire => wire.net === expected.net && touches(pin.position, wire.points, tolerance));
    const planned = wirePlan?.wires.find(wire => wire.endpoint.component === expected.designator && wire.endpoint.providerPin === expected.pin);
    const wire = matching.length === 1 ? matching[0] : matching.length === 0 ? planned : null;
    if (!wire) continue;
    const path = wire.points, pinAtStart = path.length === 2 && distance(path[0], pin.position) <= tolerance;
    const pinAtEnd = path.length === 2 && distance(path[1], pin.position) <= tolerance;
    const outer = pinAtStart ? path[1] : pinAtEnd ? path[0] : null;
    const orthogonal = outer && (Math.abs(outer.x - pin.position.x) <= tolerance || Math.abs(outer.y - pin.position.y) <= tolerance);
    const outward = outer && point(component.position) && ((outer.x - pin.position.x) * (pin.position.x - component.position.x) + (outer.y - pin.position.y) * (pin.position.y - component.position.y) > 0);
    if (!outer || !orthogonal || !outward || distance(outer, pin.position) <= tolerance || distance(outer, pin.position) > stubLength + grid + tolerance) {
      issue('EXISTING_TOPOLOGY_UNSUPPORTED', 'Only a short, straight, outward stub with the pin at its endpoint is supported.', { designator: expected.designator, pin: expected.pin, wireId: wire.primitiveId ?? null }); continue;
    }
    if (wire.primitiveId && (wire.netVisible !== true || wire.netAttrCount !== 1)) issue('WIRE_LABEL_INVALID', 'An existing stub needs exactly one visible NET attribute.', { wireId: wire.primitiveId });
    for (const other of allPins) if (!(other.designator === expected.designator && other.pin === expected.pin) && touches(other.position, path, tolerance)) issue('STUB_TOUCHES_OTHER_PIN', 'A stub contacts another physical pin; the isolated-endpoint strategy cannot own it safely.', { designator: expected.designator, pin: expected.pin, otherPin: keyFor(other.designator, other.pin) });
    const samePlace = markers.filter(marker => point(marker) && distance(marker, outer) <= tolerance);
    if (samePlace.some(marker => marker.net !== expected.net)) issue('MARKER_NET_MISMATCH', 'A different network marker occupies the intended stub endpoint.', { designator: expected.designator, pin: expected.pin, net: expected.net });
    const matchingMarkers = samePlace.filter(marker => marker.net === expected.net);
    if (matchingMarkers.length > 1) issue('DUPLICATE_MARKER', 'More than one marker occupies the same endpoint.', { designator: expected.designator, pin: expected.pin, net: expected.net });
    const net = netByName.get(expected.net);
    const flag = { ...(net?.kind === 'ground' ? { kind: 'netFlag', identification: 'Ground' } : net?.kind === 'power' ? { kind: 'netFlag', identification: 'Power' } : { kind: 'netPort', direction: 'BI' }),
      net: expected.net, x: outer.x, y: outer.y, rotation: 0, mirror: false, showName: false };
    flagItems.push(flag);
    if (!matchingMarkers.length) missingFlagItems.push(flag);
    for (const marker of matchingMarkers) {
      if (marker.nameVisible !== false || marker.nameAttrCount !== 1) issue('MARKER_LABEL_INVALID', 'A network marker needs exactly one hidden Name; wire NET is the sole visible label.', { markerId: marker.primitiveId });
      if (marker.componentType !== (flag.kind === 'netFlag' ? 'netflag' : 'netport')) issue('MARKER_TYPE_MISMATCH', 'Existing marker type differs from Contract net semantics.', { markerId: marker.primitiveId, net: expected.net });
    }
    for (const marker of markers) if (point(marker) && touches(marker, path, tolerance) && !samePlace.includes(marker)) issue('MARKER_POSITION_UNSUPPORTED', 'An extra marker lies on a stub away from its outer endpoint.', { markerId: marker.primitiveId });
    const evidence = { designator: expected.designator, pin: expected.pin, net: expected.net, wireId: wire.primitiveId ?? null, points: path, markerIds: matchingMarkers.map(marker => marker.primitiveId), existing: Boolean(wire.primitiveId) };
    endpointEvidence.push(evidence);
    candidateWires.push({ ...wire, owner: keyFor(expected.designator, expected.pin) });
  }
  for (let i = 0; i < candidateWires.length; i += 1) {
    const wire = candidateWires[i];
    for (const other of liveWires) if (wire.primitiveId !== other.primitiveId && pathsTouch(wire.points, other.points, tolerance)) issue('STUB_TOUCHES_OTHER_WIRE', 'A stub touches other wiring; this entry cannot safely infer or rearrange that topology.', { endpoint: wire.owner, otherWireId: other.primitiveId });
    for (let j = i + 1; j < candidateWires.length; j += 1) if (!wire.primitiveId && !candidateWires[j].primitiveId && pathsTouch(wire.points, candidateWires[j].points, tolerance)) issue('PLANNED_STUB_COLLISION', 'Planned endpoint stubs intersect; revise the initial placement or geometry options.', { endpoint: wire.owner, otherEndpoint: candidateWires[j].owner });
  }
  if (scope.fullDocument) {
    const ownedWireIds = new Set(endpointEvidence.map(endpoint => endpoint.wireId).filter(Boolean));
    const ownedMarkerIds = new Set(endpointEvidence.flatMap(endpoint => endpoint.markerIds));
    for (const wire of liveWires) if (!ownedWireIds.has(wire.primitiveId)) issue('UNOWNED_WIRE', 'Full-document endpoint-stub workflow cannot account for this existing wire.', { wireId: wire.primitiveId });
    for (const marker of markers) if (!ownedMarkerIds.has(marker.primitiveId)) issue('UNOWNED_MARKER', 'Full-document endpoint-stub workflow cannot account for this existing network marker.', { markerId: marker.primitiveId });
  }
  if (phase === 'verify') {
    if (wirePlan?.wires.length) issue('ENDPOINTS_INCOMPLETE', 'Required physical endpoint wires are still missing.', { count: wirePlan.wires.length });
    if (missingFlagItems.length) issue('MARKERS_INCOMPLETE', 'Required network markers are still missing.', { count: missingFlagItems.length });
    if (pendingNoConnectItems.length) issue('NC_INCOMPLETE', 'Required no-connect declarations have not been realized.', { count: pendingNoConnectItems.length });
  }
  return result();
}
