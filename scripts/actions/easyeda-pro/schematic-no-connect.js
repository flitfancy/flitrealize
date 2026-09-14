return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect', items: [] } : flitrealizeInput;
  const MAX_PINS_PER_APPLY = 30;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  function getter(object, name, fallback = null) {
    return typeof object?.[name] === 'function' ? object[name]() : fallback;
  }
  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function fingerprint(value) {
    const text = stableStringify(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    return 'fnv1a32-' + hash.toString(16).padStart(8, '0');
  }
  function pinNumber(pin) {
    return String(getter(pin, 'getState_PinNumber') ?? getter(pin, 'getState_Number') ?? getter(pin, 'getState_Name') ?? '').trim();
  }
  function noConnected(pin) {
    const value = getter(pin, 'getState_NoConnected', getter(pin, 'getState_NoConnect'));
    if (typeof value !== 'boolean') fail('PIN_STATE_UNAVAILABLE', 'The provider did not return a boolean noConnected state.');
    return value;
  }
  function normalizeItems(value) {
    if (!Array.isArray(value)) fail('INVALID_ITEMS', 'items must be an array.');
    if (value.length > MAX_PINS_PER_APPLY) fail('TOO_MANY_PINS', 'At most ' + MAX_PINS_PER_APPLY + ' pins may be changed per apply.');
    const seen = new Set();
    return value.map((item, index) => {
      const designator = String(item?.designator || '').trim();
      const pin = String(item?.pin ?? item?.pinNumber ?? '').trim();
      const key = designator + '.' + pin;
      if (!designator || !pin) fail('INVALID_ITEM', 'Item ' + index + ' needs designator and pin.');
      if (item?.noConnected !== undefined && typeof item.noConnected !== 'boolean') fail('INVALID_ITEM', key + ': noConnected must be boolean.');
      if (seen.has(key)) fail('DUPLICATE_PIN', 'Duplicate pin: ' + key);
      seen.add(key);
      return { designator, pin, key, noConnected: item?.noConnected !== false };
    });
  }
  async function documentIdentity() {
    const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (Number(document?.documentType) !== 1 || !document.uuid) fail('DOCUMENT_UNAVAILABLE', 'No active schematic is available.');
    return { uuid: document.uuid, parentProjectUuid: document.parentProjectUuid ?? null };
  }
  function assertExpected(document, source) {
    if (source.expectedDocumentUuid && document.uuid !== source.expectedDocumentUuid) fail('DOCUMENT_MISMATCH', 'The active schematic changed.');
    if (source.expectedProjectUuid && document.parentProjectUuid !== source.expectedProjectUuid) fail('PROJECT_MISMATCH', 'The active project changed.');
  }
  function stateEvidence(state) {
    return {
      document: state.document,
      wires: state.wires,
      pins: state.pins.map(({ key, identity, actualNoConnected }) => ({ key, identity, noConnected: actualNoConnected })).sort((a, b) => a.key.localeCompare(b.key)),
    };
  }
  function structuralEvidence(state) {
    const evidence = stateEvidence(state);
    evidence.pins = evidence.pins.map(({ key, identity }) => ({ key, identity }));
    return evidence;
  }
  async function capture(items, source) {
    const document = await documentIdentity();
    assertExpected(document, source);
    const components = await eda.sch_PrimitiveComponent.getAll();
    if (!Array.isArray(components)) fail('COMPONENT_STATE_UNAVAILABLE', 'Component read failed.');
    const pins = [];
    const pinsByComponent = new Map();
    for (const item of items) {
      const matches = components.filter((component) => String(getter(component, 'getState_Designator', '') || '').trim() === item.designator);
      if (matches.length !== 1) fail('COMPONENT_MATCH_FAILED', item.designator + ' resolved to ' + matches.length + ' components.');
      const component = matches[0];
      const primitiveId = getter(component, 'getState_PrimitiveId');
      if (!primitiveId) fail('COMPONENT_ID_UNAVAILABLE', item.designator + ' has no primitive identity.');
      if (!pinsByComponent.has(primitiveId)) pinsByComponent.set(primitiveId, await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId));
      const values = pinsByComponent.get(primitiveId);
      if (!Array.isArray(values)) fail('PIN_STATE_UNAVAILABLE', item.designator + ' pin read failed.');
      const matchingPins = values.filter((pin) => pinNumber(pin) === item.pin);
      if (matchingPins.length !== 1) fail('PIN_MATCH_FAILED', item.key + ' resolved to ' + matchingPins.length + ' pins.');
      const pin = matchingPins[0];
      pins.push({ ...item, pinObject: pin, actualNoConnected: noConnected(pin), identity: {
        componentId: primitiveId,
        pinId: getter(pin, 'getState_PrimitiveId', getter(pin, 'getState_Id', primitiveId + ':' + item.pin)),
        pinName: getter(pin, 'getState_PinName'),
        x: getter(pin, 'getState_X'), y: getter(pin, 'getState_Y'), rotation: getter(pin, 'getState_Rotation'),
        componentX: getter(component, 'getState_X'), componentY: getter(component, 'getState_Y'),
        componentRotation: getter(component, 'getState_Rotation'), componentMirror: getter(component, 'getState_Mirror'),
      } });
    }
    if (typeof eda.sch_PrimitiveWire?.getAll !== 'function') fail('WIRE_STATE_UNAVAILABLE', 'Wire readback is required to guard no-connect writes against stale connectivity.');
    const rawWires = await eda.sch_PrimitiveWire.getAll();
    if (!Array.isArray(rawWires)) fail('WIRE_STATE_UNAVAILABLE', 'Wire read failed.');
    const wires = rawWires.map((wire) => ({
      primitiveId: getter(wire, 'getState_PrimitiveId'),
      net: getter(wire, 'getState_Net'),
      line: getter(wire, 'getState_Line', getter(wire, 'getState_Points')),
    })).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
    if (wires.some((wire) => !wire.primitiveId || !Array.isArray(wire.line))) fail('WIRE_STATE_UNAVAILABLE', 'Wire identity or geometry is unavailable.');
    assertExpected(await documentIdentity(), { expectedDocumentUuid: document.uuid, expectedProjectUuid: document.parentProjectUuid });
    const state = { document, pins, wires };
    return { ...state, inspectionFingerprint: fingerprint(stateEvidence(state)) };
  }
  function planFingerprint(state, items) {
    return fingerprint({ inspectionFingerprint: state.inspectionFingerprint, items });
  }
  function pinReport(state) {
    return state.pins.map(({ key, actualNoConnected }) => ({ key, noConnected: actualNoConnected }));
  }
  async function mutate(items, source, mode) {
    if (!source.expectedDocumentUuid) fail('DOCUMENT_IDENTITY_REQUIRED', 'A write requires expectedDocumentUuid.');
    if (mode === 'apply' && !source.expectedPlanFingerprint) fail('INVALID_APPLY_REQUEST', 'Apply requires expectedPlanFingerprint from a fresh plan.');
    if (mode === 'rollback' && (!source.expectedCurrentFingerprint || !source.expectedRestoredFingerprint)) fail('INVALID_ROLLBACK_REQUEST', 'Rollback requires current and restored fingerprints from the apply receipt.');
    const before = await capture(items, source);
    if (mode === 'apply' && planFingerprint(before, items) !== source.expectedPlanFingerprint) fail('STALE_PLAN', 'Target pins or schematic connectivity changed after planning.');
    if (mode === 'rollback' && before.inspectionFingerprint !== source.expectedCurrentFingerprint) fail('STALE_ROLLBACK', 'Target pins or schematic connectivity changed after apply.');
    const attempted = [];
    let expected = before;
    try {
      for (const item of before.pins) {
        if (item.actualNoConnected === item.noConnected) continue;
        const current = await capture([item], source);
        const expectedPinState = { ...expected, pins: expected.pins.filter((pin) => pin.key === item.key) };
        if (current.inspectionFingerprint !== fingerprint(stateEvidence(expectedPinState))) fail('STATE_CHANGED_DURING_APPLY', 'Target pins or connectivity changed during the batch.');
        const live = current.pins.find((pin) => pin.key === item.key);
        assertExpected(await documentIdentity(), source);
        // A provider can mutate and then throw, so record the attempt before awaiting.
        attempted.push({ key: item.key, identity: item.identity, before: item.actualNoConnected, intended: item.noConnected });
        const modified = await eda.sch_PrimitivePin.modify(live.pinObject, { noConnected: item.noConnected });
        if (!modified) fail('MODIFY_FAILED', 'Failed to set no-connect=' + item.noConnected + ' on ' + item.key + '.');
        const expectedPins = expected.pins.map((pin) => pin.key === item.key ? { ...pin, actualNoConnected: item.noConnected } : pin);
        expected = { ...expected, pins: expectedPins };
        expected.inspectionFingerprint = fingerprint(stateEvidence(expected));
      }
      const after = await capture(items, source);
      if (after.inspectionFingerprint !== expected.inspectionFingerprint || after.pins.some((item) => item.actualNoConnected !== item.noConnected)) fail('VERIFY_FAILED', 'No-connect write changed unexpected state or did not retain the requested state.');
      if (mode === 'rollback' && after.inspectionFingerprint !== source.expectedRestoredFingerprint) fail('RESTORE_MISMATCH', 'Rollback did not reproduce its recorded pre-apply state.');
      return {
        schemaVersion: 2, status: mode === 'rollback' ? 'rolled-back' : 'applied', readOnly: false, saved: false,
        document: after.document, changedCount: attempted.length, pins: pinReport(after),
        beforeInspectionFingerprint: before.inspectionFingerprint, afterInspectionFingerprint: after.inspectionFingerprint,
        ...(mode === 'apply' ? { rollbackRequest: { mode: 'rollback', request: {
          items: before.pins.map(({ designator, pin, actualNoConnected }) => ({ designator, pin, noConnected: actualNoConnected })),
          expectedDocumentUuid: before.document.uuid, expectedProjectUuid: before.document.parentProjectUuid,
          expectedCurrentFingerprint: after.inspectionFingerprint, expectedRestoredFingerprint: before.inspectionFingerprint,
        } } } : {}),
      };
    } catch (error) {
      const recovery = { attempted: [], failures: [], restored: false };
      let restored = null;
      try {
        let current = await capture(items, source);
        restored = current;
        if (fingerprint(structuralEvidence(current)) !== fingerprint(structuralEvidence(before))) fail('RECOVERY_STATE_CHANGED', 'Pin identity, geometry or wire connectivity changed; recovery will not overwrite it.');
        for (const attempt of [...attempted].reverse()) {
          const live = current.pins.find((pin) => pin.key === attempt.key);
          if (live.actualNoConnected === attempt.before) continue;
          assertExpected(await documentIdentity(), source);
          recovery.attempted.push(attempt.key);
          try {
            if (!await eda.sch_PrimitivePin.modify(live.pinObject, { noConnected: attempt.before })) fail('RECOVERY_MODIFY_FAILED', 'Recovery rejected ' + attempt.key + '.');
          } catch (recoveryError) {
            recovery.failures.push({ key: attempt.key, code: recoveryError.code || 'RECOVERY_FAILED', message: recoveryError.message });
          }
          current = await capture(items, source);
          restored = current;
          if (fingerprint(structuralEvidence(current)) !== fingerprint(structuralEvidence(before))) fail('RECOVERY_STATE_CHANGED', 'Schematic changed during recovery.');
        }
        restored = await capture(items, source);
        recovery.restored = restored.inspectionFingerprint === before.inspectionFingerprint;
      } catch (recoveryError) {
        recovery.failures.push({ code: recoveryError.code || 'RECOVERY_FAILED', message: recoveryError.message });
      }
      return {
        schemaVersion: 2, status: mode === 'apply' && recovery.restored ? 'rolled-back' : 'rollback-incomplete', readOnly: false, saved: false,
        document: before.document,
        error: { code: error.code || 'APPLY_FAILED', message: error.message }, attempted, recovery,
        expectedRestoredFingerprint: before.inspectionFingerprint,
        restoredInspectionFingerprint: restored?.inspectionFingerprint ?? null,
        pins: restored ? pinReport(restored) : null,
      };
    }
  }

  const mode = request.mode || 'inspect';
  const source = request.request || request;
  const items = normalizeItems(source.items || source.plan?.items || []);
  if (mode === 'inspect' || mode === 'plan' || mode === 'verify') {
    const state = await capture(items, source);
    if (mode === 'verify' && state.pins.some((item) => item.actualNoConnected !== item.noConnected)) fail('VERIFY_FAILED', 'No-connect state differs from the requested pins.');
    return {
      schemaVersion: 2, status: mode === 'plan' ? 'planned' : mode === 'verify' ? 'verified' : 'inspected', readOnly: true,
      document: state.document, inspectionFingerprint: state.inspectionFingerprint,
      pins: mode === 'plan' ? state.pins.map(({ key, actualNoConnected, noConnected: expected }) => ({ key, actualNoConnected, expectedNoConnected: expected })) : pinReport(state),
      ...(mode === 'plan' ? {
        planFingerprint: planFingerprint(state, items),
        applyRequest: { mode: 'apply', request: { items, expectedDocumentUuid: state.document.uuid,
          expectedProjectUuid: state.document.parentProjectUuid, expectedPlanFingerprint: planFingerprint(state, items) } },
      } : {}),
    };
  }
  if (mode === 'apply' || mode === 'rollback') return mutate(items, source, mode);
  fail('INVALID_MODE', 'Unsupported mode: ' + mode);
})();
