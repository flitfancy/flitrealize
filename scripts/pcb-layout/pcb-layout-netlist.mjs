import { padOwner } from './pcb-layout-geometry.mjs';
import { layoutRealization } from './pcb-layout-provider.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const equalSets = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const endpointKey = (ref, pin) => JSON.stringify([ref, pin]);

/** Compare assigned net names, not physical copper connectivity. A native
 * number domain is resolved structurally; matching net names never select a
 * convenient logical/physical interpretation. No caller input is modified. */
export function auditNativeNetlist({ snapshot, contract, realization } = {}) {
  const diagnostics = [], numbering = [];
  const counts = { contractPcbComponents: 0, snapshotComponents: 0, nativeComponents: 0, comparedComponents: 0, nativePinEntries: 0, actualPads: 0, comparedPadAssignments: 0, comparedContractPadAssignments: 0, standalonePads: 0, nativeNetNames: null };
  const scope = { comparison: 'declared-net-assignments-not-copper-connectivity', nativeNetlist: 'unavailable', nativeNetNames: 'unavailable', formatVersion: { observed: null, validation: 'supported-structure-only;version-not-certified' }, pinNumbering: numbering, uncoveredPhysicalPins: [], excludedContractRefs: [], excludedNativeRefs: [], standalonePads: 'checked-against-contract;not-required-in-component-netlist', ownershipSource: 'explicit-owner-or-parent', partAttributes: 'not-checked' };
  let unsupported = false, apiError = false, partial = false;
  const mismatch = (code, message, detail = {}) => diagnostics.push({ severity: 'error', code, message, ...detail });
  const unknown = (code, message, detail = {}) => { unsupported = true; diagnostics.push({ severity: 'warning', code, message, ...detail }); };
  const finish = () => ({
    status: diagnostics.some(d => d.severity === 'error') ? 'mismatch' : apiError ? 'error' : unsupported ? 'unsupported' : scope.nativeNetlist === 'ok' ? (partial ? 'partial' : 'matched') : 'unavailable',
    diagnostics, counts, scope
  });
  const readEnvelope = (envelope, name) => {
    if (envelope === undefined || envelope?.status === 'unavailable') {
      diagnostics.push({ severity: 'warning', code: name + '_UNAVAILABLE', message: `${name} was not available; this is not an empty result.` });
      return false;
    }
    if (envelope?.status === 'error') {
      scope[name === 'NATIVE_NETLIST' ? 'nativeNetlist' : 'nativeNetNames'] = 'error'; apiError = true;
      diagnostics.push({ severity: 'warning', code: name + '_ERROR', message: String(envelope.error ?? `${name} read failed.`) });
      return false;
    }
    if (envelope?.status === 'unsupported' && Array.isArray(envelope.diagnostics)) {
      scope[name === 'NATIVE_NETLIST' ? 'nativeNetlist' : 'nativeNetNames'] = 'unsupported';
      unsupported = true; diagnostics.push(...envelope.diagnostics); return false;
    }
    if (!object(envelope) || envelope.status !== 'ok') {
      scope[name === 'NATIVE_NETLIST' ? 'nativeNetlist' : 'nativeNetNames'] = 'unsupported';
      unknown(name + '_STATUS_UNSUPPORTED', `Unsupported ${name} result envelope.`); return false;
    }
    return true;
  };
  if (!object(snapshot) || !object(contract) || !['components', 'pads'].every(key => Array.isArray(snapshot[key])) || !['components', 'nets'].every(key => Array.isArray(contract[key]))) {
    unknown('NETLIST_AUDIT_INPUT_UNSUPPORTED', 'A snapshot with components/pads and a Contract with components/nets is required.'); return finish();
  }

  try { realization ??= layoutRealization(snapshot, contract); }
  catch (error) { unknown('NETLIST_PROVIDER_UNSUPPORTED', error.message); return finish(); }
  let nativeDocument;
  if (readEnvelope(realization.netlist, 'NATIVE_NETLIST')) {
    if (Array.isArray(realization.netlist.components)) nativeDocument = realization.netlist;
    else unknown('NATIVE_NETLIST_FORMAT_UNSUPPORTED', 'Expected normalized component and pin records.');
    scope.nativeNetlist = nativeDocument ? 'ok' : 'unsupported';
    if (nativeDocument) scope.formatVersion.observed = nativeDocument.version ?? null;
  }
  let netNames;
  if (readEnvelope(realization.netNames, 'NATIVE_NET_NAMES')) {
    if (!Array.isArray(realization.netNames.value) || realization.netNames.value.some(n => typeof n !== 'string')) {
      scope.nativeNetNames = 'unsupported'; unknown('NATIVE_NET_NAMES_FORMAT_UNSUPPORTED', 'Expected an explicit array of native net names.');
    } else {
      netNames = new Set(realization.netNames.value.filter(n => n !== ''));
      counts.nativeNetNames = netNames.size; scope.nativeNetNames = 'ok';
    }
  }

  const records = new Map(), expected = new Map();
  for (const component of contract.components) {
    if (!object(component) || !text(component.designator) || typeof component.includeInPcb !== 'boolean' || !Array.isArray(component.pins)) { unknown('CONTRACT_SCOPE_UNSUPPORTED', 'Each component requires a designator, includeInPcb and pins.'); continue; }
    if (records.has(component.designator)) { mismatch('DUPLICATE_CONTRACT_COMPONENT', 'Contract designators must be unique.', { ref: component.designator }); continue; }
    records.set(component.designator, component);
    if (!component.includeInPcb) scope.excludedContractRefs.push(component.designator);
    else counts.contractPcbComponents++;
  }
  for (const net of contract.nets) {
    if (!object(net) || !text(net.name) || !Array.isArray(net.endpoints)) { unknown('CONTRACT_NET_UNSUPPORTED', 'Contract nets require explicit names and endpoints.'); continue; }
    for (const endpoint of net.endpoints) {
      const record = records.get(endpoint?.component);
      if (!record) { mismatch('UNKNOWN_CONTRACT_NET_COMPONENT', 'A net endpoint refers to an unknown component.', { ref: endpoint?.component }); continue; }
      if (!record.includeInPcb) continue;
      if (!text(endpoint.pin) || !record.pins.some(p => p?.number === endpoint.pin)) { mismatch('UNKNOWN_CONTRACT_NET_PIN', 'A net endpoint refers to an undeclared logical pin.', { ref: endpoint.component, pin: endpoint.pin }); continue; }
      const key = endpointKey(endpoint.component, endpoint.pin);
      if (expected.has(key) && expected.get(key) !== net.name) mismatch('CONFLICTING_CONTRACT_NET', 'One logical pin is assigned to different Contract nets.', { ref: endpoint.component, pin: endpoint.pin, expected: expected.get(key), actual: net.name });
      expected.set(key, net.name);
    }
  }
  for (const [ref, record] of records) if (record.includeInPcb) {
    const pins = new Set();
    for (const pin of record.pins) {
      if (!object(pin) || !text(pin.number) || pins.has(pin.number)) { unknown('CONTRACT_PIN_UNSUPPORTED', 'Logical pins must have unique string numbers.', { ref }); continue; }
      pins.add(pin.number);
      const key = endpointKey(ref, pin.number);
      if (['no-connect', 'dnc'].includes(pin.classification)) {
        if (expected.has(key)) mismatch('CONTRACT_NC_CONNECTED', 'A no-connect pin also has a declared net.', { ref, pin: pin.number, actual: expected.get(key) });
        else expected.set(key, '');
      } else if (!expected.has(key)) unknown('CONTRACT_PIN_NET_UNDECLARED', 'A pin without a declared net is unknown, not implicitly no-connect.', { ref, pin: pin.number });
    }
  }

  const components = new Map(), ids = new Set(), byRef = new Map(), observedNames = new Set();
  for (const component of snapshot.components) {
    if (!object(component) || !text(component.ref) || !text(component.id)) { unknown('SNAPSHOT_COMPONENT_UNSUPPORTED', 'Snapshot components require explicit refs and ids.'); continue; }
    if (components.has(component.ref) || ids.has(component.id)) { mismatch('DUPLICATE_SNAPSHOT_COMPONENT', 'Snapshot refs and ids must be unique.', { ref: component.ref }); continue; }
    components.set(component.ref, component); ids.add(component.id); byRef.set(component.ref, []);
    const record = records.get(component.ref);
    if (!record || !record.includeInPcb) mismatch('UNEXPECTED_PCB_COMPONENT', 'The current component is outside the included Contract scope.', { ref: component.ref });
  }
  counts.snapshotComponents = components.size;
  const padIds = new Set();
  for (const pad of snapshot.pads) {
    if (!object(pad) || !text(pad.id) || !text(String(pad.number ?? ''))) { unknown('SNAPSHOT_PAD_UNSUPPORTED', 'Snapshot pads require explicit ids and numbers.'); continue; }
    if (padIds.has(pad.id)) { mismatch('DUPLICATE_SNAPSHOT_PAD', 'Pad identities must be unique.', { id: pad.id }); continue; }
    padIds.add(pad.id); counts.actualPads++;
    let owner;
    try { owner = padOwner(pad, components)?.ref ?? null; }
    catch (error) { mismatch(error.message.split(' ')[0], error.message, { id: pad.id }); continue; }
    const ref = owner ?? String(pad.number), record = records.get(ref);
    if (owner === null) {
      counts.standalonePads++;
      if (components.has(ref) || byRef.has(ref)) { mismatch('DUPLICATE_STANDALONE_PAD_REF', 'An independent pad ref collides with another PCB object.', { ref }); continue; }
      if (!record?.includeInPcb || record.pins.length !== 1) mismatch('UNDECLARED_STANDALONE_PAD', 'An independent pad must correspond to an included one-pin Contract object.', { ref });
    }
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(pad);
    if (typeof pad.net !== 'string') unknown('PAD_NET_UNAVAILABLE', 'A missing pad net is unknown; only an explicit empty string means no net.', { ref, pin: String(pad.number), id: pad.id });
    else if (pad.net !== '') observedNames.add(pad.net);
  }
  for (const [ref, record] of records) if (record.includeInPcb && !byRef.has(ref)) mismatch('MISSING_PCB_COMPONENT', 'An included Contract component has no current PCB object.', { ref });

  const native = new Map(), nativeIds = new Set();
  let nativeComponentInventoryComplete = Boolean(nativeDocument);
  for (const component of nativeDocument?.components ?? []) {
    if (!object(component) || !text(component.ref) || !Array.isArray(component.pins)) { nativeComponentInventoryComplete = false; unknown('NATIVE_COMPONENT_FORMAT_UNSUPPORTED', 'Normalized components require ref and pin records.', { nativeKey: component?.nativeKey }); continue; }
    const ref = component.ref, uniqueId = component.uniqueId;
    if (native.has(ref)) { mismatch('DUPLICATE_NATIVE_COMPONENT', 'Native netlist designators must be unique.', { ref }); continue; }
    if (text(uniqueId) && nativeIds.has(uniqueId)) mismatch('DUPLICATE_NATIVE_UNIQUE_ID', 'Native netlist Unique ID values must be unique.', { ref, uniqueId });
    if (text(uniqueId)) nativeIds.add(uniqueId);
    native.set(ref, component); counts.nativeComponents++;
    const record = records.get(ref);
    if (record?.includeInPcb === false && !components.has(ref)) { scope.excludedNativeRefs.push(ref); continue; }
    if (!record?.includeInPcb || !byRef.has(ref)) mismatch('UNEXPECTED_NATIVE_COMPONENT', 'Native netlist component is outside the current included PCB scope.', { ref });
  }
  if (nativeComponentInventoryComplete) for (const ref of components.keys()) if (!native.has(ref)) mismatch('MISSING_NATIVE_COMPONENT', 'A current PCB component is missing from the native netlist.', { ref });

  for (const [ref, actual] of byRef) {
    const record = records.get(ref);
    if (!record?.includeInPcb || !Array.isArray(record.pins)) continue;
    const standalone = !components.has(ref), logical = new Map(), physical = new Map(), actualByNumber = new Map();
    for (const pad of actual) {
      const number = String(pad.number);
      if (!actualByNumber.has(number)) actualByNumber.set(number, []);
      actualByNumber.get(number).push(pad);
    }
    for (const [number, pads] of actualByNumber) {
      const nets = new Set(pads.filter(p => typeof p.net === 'string').map(p => p.net));
      if (nets.size > 1) mismatch('DUPLICATE_PAD_NET_CONFLICT', 'Physical pads with the same component pin number have different nets.', { ref, pin: number, actual: [...nets] });
    }
    for (const pin of record.pins) {
      if (!text(pin?.number)) continue;
      const mapped = standalone ? actual.map(p => String(p.number)) : realization.pinMaps[ref]?.[pin.number] ?? [pin.number];
      if (!Array.isArray(mapped) || !mapped.length || mapped.some(number => !text(String(number ?? '')))) { unknown('PIN_MAP_UNSUPPORTED', 'Each logical pin requires an explicit nonempty physical-number mapping.', { ref, pin: pin.number }); continue; }
      const numbers = [...new Set(mapped.map(String))], net = expected.get(endpointKey(ref, pin.number));
      logical.set(pin.number, { numbers, net });
      for (const number of numbers) {
        if (!actualByNumber.has(number)) mismatch('MISSING_PHYSICAL_PIN', 'A mapped logical pin has no actual PCB pad.', { ref, pin: pin.number, physicalPin: number });
        if (physical.has(number) && physical.get(number) !== undefined && net !== undefined && physical.get(number) !== net) mismatch('CONFLICTING_PHYSICAL_PIN_MAP', 'Logical pins from different nets map to the same physical number.', { ref, physicalPin: number, expected: physical.get(number), actual: net });
        else if (!physical.has(number) || net !== undefined) physical.set(number, net);
      }
    }
    for (const [number, pads] of actualByNumber) {
      if (!physical.has(number)) {
        // Complete logical pin mapping does not claim that every footprint pad
        // has a declared electrical role. An explicit empty assignment is not
        // inferred to be NC or a mechanical pad.
        const nets = [...new Set(pads.filter(p => typeof p.net === 'string').map(p => p.net))];
        scope.uncoveredPhysicalPins.push({ ref, pin: number, padIds: pads.map(p => p.id), actualNets: nets, actualNetUnavailable: pads.some(p => typeof p.net !== 'string'), nativeNet: null, nativeNetCompared: false, classification: 'not-declared' });
        if (nets.some(net => net !== '')) mismatch('UNDECLARED_PAD_CONNECTION', 'A physical pad outside the logical pin mapping has an assigned net.', { ref, pin: number, actual: nets });
        else {
          partial = true;
          diagnostics.push({ severity: 'warning', code: 'UNDECLARED_EMPTY_PHYSICAL_PIN', message: 'This physical pad has no declared Contract role; an empty net does not certify NC or mechanical purpose.', ref, pin: number });
        }
      }
      for (const pad of pads) if (physical.get(number) !== undefined && typeof pad.net === 'string') {
        counts.comparedContractPadAssignments++;
        if (pad.net !== physical.get(number)) mismatch('PAD_CONTRACT_NET_MISMATCH', 'Actual pad net differs from the mapped Contract net.', { ref, pin: number, id: pad.id, expected: physical.get(number), actual: pad.net });
      }
    }
    const component = native.get(ref);
    if (!component) continue; // Independent pads are often absent from native component netlists.
    const nativePins = new Map();
    let nativePinInventoryComplete = true;
    for (const pin of component.pins) {
      if (!object(pin) || !text(String(pin.number ?? ''))) { nativePinInventoryComplete = false; unknown('NATIVE_PIN_FORMAT_UNSUPPORTED', 'Native pin entries require an explicit number.', { ref, nativeKey: pin?.nativeKey }); continue; }
      const number = String(pin.number); counts.nativePinEntries++;
      if (typeof pin.net !== 'string') unknown('NATIVE_PIN_NET_UNAVAILABLE', 'A missing native pin net is unknown, not no-connect.', { ref, pin: number });
      else if (pin.net !== '') observedNames.add(pin.net);
      if (nativePins.has(number) && nativePins.get(number) !== pin.net) mismatch('DUPLICATE_NATIVE_PIN_NET_CONFLICT', 'Repeated native pin numbers have different nets.', { ref, pin: number, expected: nativePins.get(number), actual: pin.net });
      else nativePins.set(number, pin.net);
    }
    const nativeNumbers = new Set(nativePins.keys()), logicalNumbers = new Set(logical.keys()), physicalNumbers = new Set(actualByNumber.keys());
    const couldBeLogical = [...nativeNumbers].every(number => logicalNumbers.has(number));
    const couldBePhysical = [...nativeNumbers].every(number => physicalNumbers.has(number));
    const identityEquivalent = equalSets(logicalNumbers, physicalNumbers) && [...logical].every(([number, value]) => value.numbers.length === 1 && value.numbers[0] === number);
    let mode;
    if (couldBeLogical && couldBePhysical) {
      if (identityEquivalent) mode = 'identity-equivalent';
      else if (!nativeNumbers.size) { if (nativePinInventoryComplete) mismatch('MISSING_NATIVE_PINS', 'A nonempty component has no native pin entries.', { ref }); continue; }
      else { numbering.push({ ref, mode: 'ambiguous' }); unknown('NATIVE_PIN_NUMBERING_AMBIGUOUS', 'Logical and physical numbering both fit but imply different mappings; net agreement is not used to choose one.', { ref }); continue; }
    } else if (couldBeLogical) mode = 'logical';
    else if (couldBePhysical) mode = 'physical';
    else { numbering.push({ ref, mode: 'unsupported' }); unknown('NATIVE_PIN_NUMBERING_UNSUPPORTED', 'Native pin numbers do not identify a supported logical or physical domain.', { ref }); continue; }
    numbering.push({ ref, mode, evidence: 'number-domain-and-explicit-pin-map;not-net-name-matching' });
    const expectedNumbers = mode === 'logical' ? logicalNumbers : physicalNumbers;
    if (nativePinInventoryComplete) for (const pin of expectedNumbers) if (!nativePins.has(pin)) mismatch('MISSING_NATIVE_PIN', 'A known component pin is missing from the native netlist.', { ref, pin, numbering: mode });
    for (const [number, net] of nativePins) {
      if (typeof net !== 'string') continue;
      const targetNumbers = mode === 'logical' ? logical.get(number).numbers : [number];
      const contractNet = mode === 'logical' ? logical.get(number).net : physical.get(number);
      if (contractNet !== undefined && contractNet !== net) mismatch('NATIVE_CONTRACT_NET_MISMATCH', 'Native pin net differs from the declared Contract net.', { ref, pin: number, numbering: mode, expected: contractNet, actual: net });
      for (const physicalPin of targetNumbers) {
        const uncovered = scope.uncoveredPhysicalPins.find(p => p.ref === ref && p.pin === physicalPin);
        if (uncovered) {
          uncovered.nativeNet = net; uncovered.nativeNetCompared = true;
          if (net !== '') mismatch('UNDECLARED_NATIVE_PIN_CONNECTION', 'Native netlist assigns a net to a physical pin outside the logical mapping.', { ref, pin: number, physicalPin, actual: net });
        }
      }
      for (const physicalPin of targetNumbers) for (const pad of actualByNumber.get(physicalPin) ?? []) {
        if (typeof pad.net !== 'string') continue;
        counts.comparedPadAssignments++;
        if (pad.net !== net) mismatch('NATIVE_PAD_NET_MISMATCH', 'Native pin net differs from the actual pad net.', { ref, pin: number, physicalPin, id: pad.id, expected: net, actual: pad.net });
      }
    }
    counts.comparedComponents++;
  }
  if (netNames) for (const name of observedNames) if (!netNames.has(name)) mismatch('NATIVE_NET_NAME_MISSING', 'A net assigned to a current pin or pad is absent from the native net-name inventory.', { net: name });
  return finish();
}
