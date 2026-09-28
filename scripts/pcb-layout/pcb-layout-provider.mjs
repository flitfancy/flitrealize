import * as easyedaPro from '../providers/easyeda-pro/pcb-layout.mjs';

// Only implemented providers are registered. This is the single default for
// older EasyEDA project inputs that do not yet declare their provider.
export const defaultLayoutProvider = 'easyeda-pro';
const providers = new Map([[defaultLayoutProvider, easyedaPro]]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim().length > 0;
const pinNumber = value => identifier(value) || Number.isInteger(value);
const fail = (code, field) => { throw Error(code + (field ? ' ' + field : '')); };

function providerIdentity(value) {
  if (value !== undefined && !identifier(value)) fail('INVALID_LAYOUT_PROVIDER');
  return value;
}

function validateLabelAlignment(value, provider) {
  if (!object(value) || !(identifier(value.bottomLeft) || Number.isInteger(value.bottomLeft))) fail('INVALID_LAYOUT_LABEL_ALIGNMENT', 'bottomLeft');
  const registered = providers.get(provider);
  if (registered && value.bottomLeft !== registered.labelAlignment.bottomLeft) fail('LAYOUT_LABEL_ALIGNMENT_MISMATCH', provider);
  return value;
}

function validateEnvelope(value, field, dataField) {
  if (value === undefined) return;
  if (!object(value) || !['ok', 'unavailable', 'unsupported', 'error'].includes(value.status)) fail('INVALID_LAYOUT_NET_ENVELOPE', field);
  if (value.status === 'unsupported' && value.diagnostics !== undefined
    && (!Array.isArray(value.diagnostics) || value.diagnostics.some(item => !object(item)
      || !['info', 'warning', 'error'].includes(item.severity) || typeof item.code !== 'string' || typeof item.message !== 'string'))) fail('INVALID_LAYOUT_NET_ENVELOPE', field + '.diagnostics');
  if (value.status !== 'ok') return;
  if (!Array.isArray(value[dataField]) || (dataField === 'value' && value.value.some(name => typeof name !== 'string'))) fail('INVALID_LAYOUT_NET_ENVELOPE', field + '.' + dataField);
}

function validateRealization(value, snapshot, providerId) {
  if (!object(value) || value.schemaVersion !== 1 || !identifier(value.provider)
    || !object(value.layers) || !object(value.pinMaps)) fail('INVALID_LAYOUT_REALIZATION');
  if ((providerId !== undefined && value.provider !== providerId)
    || (snapshot.provider !== undefined && value.provider !== snapshot.provider)) fail('LAYOUT_PROVIDER_MISMATCH');
  if (value.units !== 'mil') fail('UNSUPPORTED_LAYOUT_UNITS');
  if (value.coordinateSystem !== 'cartesian-y-up') fail('UNSUPPORTED_LAYOUT_COORDINATES');
  if (snapshot.units !== undefined && snapshot.units !== value.units) fail('LAYOUT_UNIT_MISMATCH');
  const normalizeCoordinates = providers.get(value.provider)?.normalizeCoordinateSystem;
  const sourceCoordinates = normalizeCoordinates ? normalizeCoordinates(snapshot.coordinateSystem) : snapshot.coordinateSystem;
  if (sourceCoordinates !== undefined && sourceCoordinates !== value.coordinateSystem) fail('LAYOUT_COORDINATE_MISMATCH');
  for (const [id, role] of Object.entries(value.layers)) if (!identifier(id) || (role !== null && !identifier(role))) fail('INVALID_LAYOUT_LAYER_ROLE', id);
  for (const [ref, mapping] of Object.entries(value.pinMaps)) {
    if (!identifier(ref) || !object(mapping)) fail('INVALID_LAYOUT_PIN_MAP', ref);
    for (const [pin, numbers] of Object.entries(mapping)) {
      if (!identifier(pin) || !Array.isArray(numbers) || !numbers.length || numbers.some(number => !pinNumber(number))) fail('INVALID_LAYOUT_PIN_MAP', ref + '.' + pin);
    }
  }
  const undeclared = snapshot.pads?.find(pad => pad?.owner === undefined && pad?.parentComponentId === undefined);
  if (undeclared) fail('PAD_OWNERSHIP_REQUIRED', undeclared.id + ': read a fresh snapshot with explicit owner or parent');
  if (snapshot.pads?.some(pad => pad?.owner !== undefined && pad.owner !== null && !identifier(pad.owner))) fail('INVALID_LAYOUT_PAD_OWNER');
  if (snapshot.pads?.some(pad => pad?.parentComponentId !== undefined && pad.parentComponentId !== null && !identifier(pad.parentComponentId))) fail('INVALID_LAYOUT_PAD_PARENT');
  validateLabelAlignment(value.labelAlignment, value.provider);
  validateEnvelope(value.netlist, 'netlist', 'components');
  validateEnvelope(value.netNames, 'netNames', 'value');
  return value;
}

export function getLayoutProvider(id = defaultLayoutProvider) {
  providerIdentity(id);
  const provider = providers.get(id);
  if (!provider) throw Error('UNSUPPORTED_LAYOUT_PROVIDER ' + id);
  return { id, ...provider };
}

export function layoutRealization(snapshot, contract, providerId, mechanical) {
  if (!object(snapshot)) throw Error('INVALID_LAYOUT_SNAPSHOT');
  for (const field of ['components', 'pads', 'items']) if (snapshot[field] !== undefined && !Array.isArray(snapshot[field])) fail('INVALID_LAYOUT_SNAPSHOT', field);
  providerIdentity(providerId); providerIdentity(snapshot.provider);
  const normalized = snapshot.layout;
  if (normalized !== undefined) {
    return validateRealization(normalized, snapshot, providerId);
  }
  if (providerId !== undefined && snapshot.provider !== undefined && providerId !== snapshot.provider) throw Error('LAYOUT_PROVIDER_MISMATCH');
  const provider = getLayoutProvider(providerId ?? snapshot.provider);
  return validateRealization(provider.layoutRealization(snapshot, contract, mechanical), snapshot, provider.id);
}

export function layoutLabelAlignment(snapshot) {
  if (snapshot?.layout !== undefined) {
    if (!object(snapshot.layout) || !identifier(snapshot.layout.provider)) fail('INVALID_LAYOUT_REALIZATION');
    providerIdentity(snapshot.provider);
    if (snapshot.provider !== undefined && snapshot.provider !== snapshot.layout.provider) fail('LAYOUT_PROVIDER_MISMATCH');
    return validateLabelAlignment(snapshot.layout.labelAlignment, snapshot.layout.provider);
  }
  return getLayoutProvider(snapshot?.provider).labelAlignment;
}
