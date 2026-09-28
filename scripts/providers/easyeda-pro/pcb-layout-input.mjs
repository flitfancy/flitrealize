// EasyEDA data conventions live here; geometry and net comparisons use the
// resulting layer roles, pin maps and component/pin records.
import { decodeBoard } from './pcb-layout-board.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const roles = new Map([[1, 'top-copper'], [2, 'bottom-copper'], [3, 'top-silkscreen'], [4, 'bottom-silkscreen'], [12, 'all-copper']]);
export const labelAlignment = Object.freeze({ bottomLeft: 3 });
export const normalizeCoordinateSystem = value => value === 'eda-y-up' ? 'cartesian-y-up' : value;

function unsupportedEnvelope(envelope, code, message) {
  return { ...(object(envelope) ? envelope : {}), status: 'unsupported', diagnostics: [{ severity: 'warning', code, message }] };
}

function observationEnvelope(envelope, kind) {
  if (envelope === undefined) return undefined;
  return object(envelope) && ['ok', 'unavailable', 'unsupported', 'error'].includes(envelope.status) ? envelope
    : unsupportedEnvelope(envelope, kind + '_STATUS_UNSUPPORTED', 'The native observation has an unknown result envelope.');
}

export function decodeNetlist(envelope) {
  envelope = observationEnvelope(envelope, 'NATIVE_NETLIST');
  if (envelope?.status !== 'ok') return envelope;
  const unsupported = (code, message) => unsupportedEnvelope(envelope, code, message);
  if (envelope.source !== 'pcb_Net.getNetlist' || typeof envelope.raw !== 'string') return unsupported('NATIVE_NETLIST_FORMAT_UNSUPPORTED', 'Expected the raw string from pcb_Net.getNetlist.');
  let value;
  try { value = JSON.parse(envelope.raw); }
  catch { return unsupported('NATIVE_NETLIST_JSON_UNSUPPORTED', 'The native result is not a supported JSON netlist.'); }
  if (!object(value) || !object(value.components)) return unsupported('NATIVE_NETLIST_FORMAT_UNSUPPORTED', 'Expected a top-level components object.');
  return {
    status: 'ok', source: envelope.source, version: value.version ?? null,
    components: Object.entries(value.components).map(([nativeKey, c]) => ({
      nativeKey, ref: c?.props?.Designator, uniqueId: c?.props?.['Unique ID'],
      pins: object(c?.pinInfoMap) ? Object.entries(c.pinInfoMap).map(([nativeKey, p]) => ({ nativeKey, number: p?.number, net: p?.net })) : null,
    })),
  };
}

function decodeNetNames(envelope) {
  const value = observationEnvelope(envelope, 'NATIVE_NET_NAMES');
  if (value?.status !== 'ok') return value;
  return Array.isArray(value.value) && value.value.every(name => typeof name === 'string') ? value
    : unsupportedEnvelope(value, 'NATIVE_NET_NAMES_FORMAT_UNSUPPORTED', 'Expected an explicit native net-name array; missing values are not an empty list.');
}

function componentPinMap(component) {
  if (component.bindings !== undefined && !object(component.bindings)) throw Error('INVALID_EASYEDA_BINDING ' + component.designator);
  const binding = component.bindings?.easyedaPro;
  if (binding !== undefined && !object(binding)) throw Error('INVALID_EASYEDA_BINDING ' + component.designator);
  return structuredClone(binding?.pinMap === undefined ? {} : binding.pinMap);
}

export function layoutRealization(snapshot, contract, mechanical = {}) {
  const layers = {};
  for (const o of [...array(snapshot.components), ...array(snapshot.pads), ...array(snapshot.items)]) {
    layers[o.id] = roles.get(o.layer === undefined ? o.original?.layer : o.layer) ?? null;
  }
  return {
    schemaVersion: 1, provider: 'easyeda-pro',
    units: snapshot.units === undefined ? 'mil' : snapshot.units,
    coordinateSystem: normalizeCoordinateSystem(snapshot.coordinateSystem === undefined ? 'eda-y-up' : snapshot.coordinateSystem),
    layers, labelAlignment, board: decodeBoard(snapshot.outlines),
    pinMaps: Object.fromEntries(array(contract?.components).map(c => [c.designator, componentPinMap(c)])),
    netlist: decodeNetlist(snapshot.nativeNetlist), netNames: decodeNetNames(snapshot.nativeNetNames),
    target: { projectId: mechanical.expectedProjectUuid ?? snapshot.document?.parentProjectUuid ?? null, documentId: mechanical.expectedDocumentUuid ?? snapshot.document?.uuid ?? null },
    provenance: { layerConvention: 'easyeda-pro-layer-ids', pinMapSource: 'Contract.bindings.easyedaPro', legacyUnitsAssumed: snapshot.units === undefined, legacyCoordinatesAssumed: snapshot.coordinateSystem === undefined },
  };
}
