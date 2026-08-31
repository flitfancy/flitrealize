return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const MAX_CANDIDATES_PER_COMPONENT = 25;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
  }

  function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function normalized(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function firstText(...values) {
    for (const value of values) {
      const result = text(value);
      if (result) return result;
    }
    return null;
  }

  function finiteInteger(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isInteger(number) && number > 0) return number;
    }
    return null;
  }

  function validateContract(contract) {
    if (!contract || contract.kind !== 'flitrealize.schematic-contract' || contract.schemaVersion !== 1) {
      fail('INVALID_CONTRACT', 'A SchematicContract v1 object is required.');
    }
    if (!Array.isArray(contract.components)) fail('INVALID_CONTRACT', 'contract.components must be an array.');
    return contract;
  }

  function normalizePinMap(value, component) {
    if (value === undefined || value === null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('INVALID_PIN_MAP', `${component.designator}: pinMap must be an object keyed by Contract pin name.`);
    }
    const contractPins = new Set((component.pins || []).map((pin) => String(pin.number)));
    const normalizedMap = {};
    for (const [semanticPin, providerPins] of Object.entries(value)) {
      const key = text(semanticPin);
      if (!key || !contractPins.has(key)) {
        fail('INVALID_PIN_MAP', `${component.designator}: pinMap key ${semanticPin} is not a declared Contract pin.`);
      }
      const source = Array.isArray(providerPins) ? providerPins : [providerPins];
      const pins = [...new Set(source
        .map((pin) => (pin === null || pin === undefined ? null : text(String(pin))))
        .filter(Boolean))];
      if (!pins.length) fail('INVALID_PIN_MAP', `${component.designator}.${key} must map to at least one Provider pin.`);
      normalizedMap[key] = pins;
    }
    return normalizedMap;
  }

  function normalizeBinding(value, component, source) {
    if (!value || typeof value !== 'object') return null;
    const libraryUuid = firstText(value.libraryUuid, value.libraryUUID);
    const deviceUuid = firstText(value.deviceUuid, value.uuid, value.deviceUUID);
    if (!libraryUuid || !deviceUuid) return null;
    return {
      libraryUuid,
      deviceUuid,
      deviceName: firstText(value.deviceName, value.name),
      manufacturer: text(value.manufacturer),
      mpn: text(value.mpn),
      footprint: text(value.footprint),
      supplierId: text(value.supplierId),
      pinMap: normalizePinMap(value.pinMap, component),
      resolution: { source, verified: false },
    };
  }

  function extractSearchKey(component, searchMapping) {
    const mapped = text(searchMapping?.[component.designator]);
    if (mapped) return mapped;
    const identity = component.identity || {};
    if (text(identity.manufacturer) && text(identity.mpn)) return `${identity.manufacturer} ${identity.mpn}`;
    if (text(identity.mpn)) return identity.mpn;
    if (text(identity.value) && component.footprint?.name) return `${identity.value} ${component.footprint.name}`;
    return null;
  }

  async function searchDevices(query) {
    if (typeof eda?.lib_Device?.search !== 'function') {
      fail('CAPABILITY_UNAVAILABLE', 'EasyEDA lib_Device.search is unavailable.');
    }
    try {
      const result = await eda.lib_Device.search(query);
      const all = Array.isArray(result) ? result : [];
      return { devices: all.slice(0, MAX_CANDIDATES_PER_COMPONENT), truncated: all.length > MAX_CANDIDATES_PER_COMPONENT };
    } catch (error) {
      const wrapped = new Error(`EasyEDA library search failed for "${query}": ${error.message}`);
      wrapped.code = 'LIBRARY_SEARCH_FAILED';
      throw wrapped;
    }
  }

  function candidateIdentity(device) {
    const footprintValue = device.footprint;
    const footprint = typeof footprintValue === 'object' && footprintValue !== null
      ? firstText(footprintValue.name, footprintValue.displayName, footprintValue.uuid)
      : firstText(footprintValue, device.package, device.packageName, device.footprintName);
    return {
      libraryUuid: firstText(device.libraryUuid, device.libraryUUID, device.library?.uuid),
      deviceUuid: firstText(device.uuid, device.deviceUuid, device.deviceUUID),
      name: firstText(device.name, device.title, device.displayName),
      manufacturer: firstText(device.manufacturer, device.manufacturerName, device.brand),
      mpn: firstText(device.mpn, device.manufacturerPart, device.manufacturerPartNumber, device.partNumber),
      footprint,
      pinCount: finiteInteger(device.pinCount, device.pinsCount, Array.isArray(device.pins) ? device.pins.length : null),
      supplierId: firstText(device.supplierId, device.lcsc, device.lcscPart),
    };
  }

  function exactField(expected, actual) {
    if (!text(expected)) return { required: false, matched: true, evidence: 'not-required' };
    if (!text(actual)) return { required: true, matched: false, evidence: 'missing' };
    return { required: true, matched: normalized(expected) === normalized(actual), evidence: 'reported' };
  }

  function expectedProviderPinCount(component) {
    return finiteInteger(
      component.extensions?.easyedaPro?.expectedPinCount,
      component.extensions?.provider?.expectedPinCount,
    );
  }

  function evaluateCandidate(component, device, index, truncated) {
    const identity = component.identity || {};
    const candidate = candidateIdentity(device);
    const manufacturer = exactField(identity.manufacturer, candidate.manufacturer);
    const mpn = exactField(identity.mpn, candidate.mpn);
    const footprintExpected = component.footprint?.selection === 'exact' ? component.footprint?.name : null;
    const footprint = exactField(footprintExpected, candidate.footprint);
    const expectedPinCount = expectedProviderPinCount(component);
    const pinCount = expectedPinCount === null
      ? { required: false, matched: true, evidence: 'not-required' }
      : candidate.pinCount === null
        ? { required: true, matched: false, evidence: 'missing' }
        : { required: true, matched: candidate.pinCount === expectedPinCount, evidence: 'reported' };
    const fields = { manufacturer, mpn, footprint, pinCount };
    const requiredChecks = Object.values(fields).filter((field) => field.required);
    const autoSelectable = component.identity?.selection === 'exact'
      && Boolean(text(identity.mpn))
      && Boolean(candidate.libraryUuid && candidate.deviceUuid)
      && !truncated
      && requiredChecks.length > 0
      && requiredChecks.every((field) => field.matched && field.evidence === 'reported');
    return {
      key: candidate.deviceUuid || `${component.designator}:${index}`,
      ...candidate,
      match: fields,
      score: requiredChecks.filter((field) => field.matched).length,
      autoSelectable,
    };
  }

  async function candidatesFor(component, searchMapping, cache) {
    const query = extractSearchKey(component, searchMapping);
    if (!query) {
      return {
        query: null,
        candidates: [],
        truncated: false,
        issue: { code: 'NO_SEARCH_KEY', message: `${component.designator}: no exact MPN or explicit search mapping.` },
      };
    }
    let search = cache.get(query);
    if (!search) {
      search = await searchDevices(query);
      cache.set(query, search);
    }
    const candidates = search.devices.map((device, index) => evaluateCandidate(component, device, index, search.truncated));
    return {
      query,
      candidates,
      truncated: search.truncated,
      issue: candidates.length
        ? null
        : { code: 'LIBRARY_NOT_FOUND', message: `${component.designator}: "${query}" was not found in the EasyEDA library.` },
    };
  }

  function explicitBinding(value, component, fallbackPinMap) {
    if (!value) return null;
    if (typeof value !== 'object') fail('INVALID_SELECTION', `${component.designator}: selection must be an object.`);
    const binding = normalizeBinding({ ...value, pinMap: value.pinMap ?? fallbackPinMap }, component, 'explicit');
    if (!binding) fail('INVALID_SELECTION', `${component.designator}: selection requires libraryUuid and deviceUuid/uuid.`);
    return binding;
  }

  function candidateBinding(candidate, query, component, pinMap) {
    return {
      libraryUuid: candidate.libraryUuid,
      deviceUuid: candidate.deviceUuid,
      deviceName: candidate.name,
      manufacturer: candidate.manufacturer,
      mpn: candidate.mpn,
      footprint: candidate.footprint,
      supplierId: candidate.supplierId,
      pinMap: normalizePinMap(pinMap, component),
      resolution: { source: 'unique-exact-match', verified: true, query, match: candidate.match },
    };
  }

  function fingerprintBindings(bindings) {
    return hashText(stableStringify(Object.entries(bindings)
      .map(([designator, binding]) => ({ designator, binding }))
      .sort((left, right) => left.designator.localeCompare(right.designator))));
  }

  async function searchContract(contract, searchMapping) {
    const cache = new Map();
    const results = [];
    for (const component of contract.components) {
      const existing = normalizeBinding(component.bindings?.easyedaPro, component, 'contract-binding');
      if (existing) {
        results.push({ designator: component.designator, existingBinding: true, query: null, candidates: [], truncated: false, issue: null });
        continue;
      }
      results.push({ designator: component.designator, ...await candidatesFor(component, searchMapping, cache) });
    }
    return results;
  }

  const mode = request.mode ?? 'inspect';
  const contract = validateContract(request.contract);
  const contractFingerprint = hashText(stableStringify(contract));

  if (mode === 'inspect') {
    const existingCount = contract.components.filter((component) => normalizeBinding(component.bindings?.easyedaPro, component, 'contract-binding')).length;
    return {
      schemaVersion: 3,
      status: 'inspected',
      readOnly: true,
      componentCount: contract.components.length,
      existingBindingCount: existingCount,
      needsBindingCount: contract.components.length - existingCount,
      contractFingerprint,
    };
  }

  if (mode === 'search') {
    const results = await searchContract(contract, request.searchMapping || {});
    const gaps = results.filter((result) => result.issue || result.truncated);
    return {
      schemaVersion: 3,
      status: gaps.length ? 'searched-with-gaps' : 'searched',
      readOnly: true,
      componentCount: contract.components.length,
      candidateCount: results.reduce((total, result) => total + result.candidates.length, 0),
      unresolvedCount: gaps.length,
      results,
      contractFingerprint,
    };
  }

  if (mode === 'resolve') {
    const selections = request.selections || {};
    const pinMaps = request.pinMaps || {};
    const searchMapping = request.searchMapping || {};
    const cache = new Map();
    const providerBindings = {};
    const unresolved = [];
    const evidence = [];
    for (const component of contract.components) {
      const existing = normalizeBinding(component.bindings?.easyedaPro, component, 'contract-binding');
      if (existing) {
        providerBindings[component.designator] = existing;
        evidence.push({ designator: component.designator, source: 'contract-binding' });
        continue;
      }
      const explicit = explicitBinding(selections[component.designator], component, pinMaps[component.designator]);
      if (explicit) {
        providerBindings[component.designator] = explicit;
        evidence.push({ designator: component.designator, source: 'explicit' });
        continue;
      }
      const result = await candidatesFor(component, searchMapping, cache);
      const selectable = result.candidates.filter((candidate) => candidate.autoSelectable);
      if (selectable.length === 1) {
        providerBindings[component.designator] = candidateBinding(selectable[0], result.query, component, pinMaps[component.designator]);
        evidence.push({ designator: component.designator, source: 'unique-exact-match', query: result.query });
        continue;
      }
      const code = result.issue?.code
        || (result.truncated ? 'SEARCH_RESULT_TRUNCATED' : selectable.length > 1 ? 'AMBIGUOUS_EXACT_MATCH' : 'EXPLICIT_SELECTION_REQUIRED');
      const message = result.issue?.message
        || `${component.designator}: ${result.truncated ? 'the candidate set was truncated' : selectable.length > 1 ? 'multiple exact candidates remain' : 'no uniquely proven exact candidate'}; provide selections.${component.designator}.`;
      unresolved.push({ designator: component.designator, code, message, candidateCount: result.candidates.length });
    }
    const bindingFingerprint = fingerprintBindings(providerBindings);
    return {
      schemaVersion: 3,
      status: unresolved.length ? 'resolved-with-blockers' : 'resolved',
      readOnly: true,
      provider: 'easyeda-pro',
      componentCount: contract.components.length,
      resolvedCount: Object.keys(providerBindings).length,
      unresolvedCount: unresolved.length,
      providerBindings,
      evidence,
      unresolved,
      diagnostics: unresolved.map((item) => ({ severity: 'error', code: item.code, message: item.message, designator: item.designator })),
      contractFingerprint,
      bindingFingerprint,
    };
  }

  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
