return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const VALID_IDENTIFICATIONS = new Set(['Power', 'Ground', 'AnalogGround', 'ProtectGround']);
  const VALID_DIRECTIONS = new Set(['IN', 'OUT', 'BI']);

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function callGetter(object, name, fallback = null) {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
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

  async function optionalCall(namespace, method) {
    if (typeof eda?.[namespace]?.[method] !== 'function') return { value: null, error: null };
    try {
      return { value: await eda[namespace][method](), error: null };
    } catch (error) {
      return { value: null, error: error.message };
    }
  }

  function summarizeFlag(comp) {
    return {
      primitiveId: callGetter(comp, 'getState_PrimitiveId'),
      net: callGetter(comp, 'getState_Net', ''),
      componentType: callGetter(comp, 'getState_ComponentType'),
      x: callGetter(comp, 'getState_X'),
      y: callGetter(comp, 'getState_Y'),
    };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const document = documentProbe.value
      ? { uuid: documentProbe.value.uuid ?? null, parentProjectUuid: documentProbe.value.parentProjectUuid ?? null }
      : null;

    const allComponents = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const components = Array.isArray(allComponents.value) ? allComponents.value : [];

    const inspectionFingerprint = hashText(stableStringify({
      documentUuid: document?.uuid,
      componentCount: components.length,
      componentIds: components.map((c) => callGetter(c, 'getState_PrimitiveId')).sort(),
    }));

    return { document, components, inspectionFingerprint };
  }

  function normalizeItems(items) {
    if (!Array.isArray(items)) fail('INVALID_REQUEST', 'items must be an array');
    return items.map((item, index) => {
      if (!item.kind) fail('INVALID_ITEM', `Item ${index}: kind is required ('netFlag' or 'netPort')`);
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
        fail('INVALID_ITEM', `Item ${index}: x and y must be finite numbers`);
      }
      if (!item.net || typeof item.net !== 'string') {
        fail('INVALID_ITEM', `Item ${index}: net name is required`);
      }
      if (item.kind === 'netFlag') {
        if (!VALID_IDENTIFICATIONS.has(item.identification)) {
          fail('INVALID_ITEM', `Item ${index}: identification must be one of ${[...VALID_IDENTIFICATIONS].join(', ')}`);
        }
        return {
          index,
          kind: 'netFlag',
          identification: item.identification,
          net: item.net,
          x: item.x,
          y: item.y,
          rotation: item.rotation ?? 0,
          mirror: item.mirror ?? false,
        };
      }
      if (item.kind === 'netPort') {
        if (!VALID_DIRECTIONS.has(item.direction)) {
          fail('INVALID_ITEM', `Item ${index}: direction must be one of ${[...VALID_DIRECTIONS].join(', ')}`);
        }
        return {
          index,
          kind: 'netPort',
          direction: item.direction,
          net: item.net,
          x: item.x,
          y: item.y,
          rotation: item.rotation ?? 0,
          mirror: item.mirror ?? false,
        };
      }
      fail('INVALID_ITEM', `Item ${index}: unknown kind '${item.kind}'`);
    });
  }

  async function applyItems(items) {
    const state = await captureState();
    const created = [];
    try {
      for (const item of items) {
        let primitive;
        if (item.kind === 'netFlag') {
          primitive = await eda.sch_PrimitiveComponent.createNetFlag(
            item.identification, item.net, item.x, item.y, item.rotation, item.mirror,
          );
        } else {
          primitive = await eda.sch_PrimitiveComponent.createNetPort(
            item.direction, item.net, item.x, item.y, item.rotation, item.mirror,
          );
        }
        if (!primitive) fail('CREATE_FLAG_FAILED', `EasyEDA rejected ${item.kind} at index ${item.index}.`);
        const primitiveId = callGetter(primitive, 'getState_PrimitiveId');
        if (!primitiveId) fail('CREATE_FLAG_WITHOUT_ID', `${item.kind} at index ${item.index} has no primitive ID.`);
        created.push({ index: item.index, primitiveId, ...summarizeFlag(primitive) });
      }
      const after = await captureState();
      return {
        status: 'applied',
        readOnly: false,
        saved: false,
        beforeInspectionFingerprint: state.inspectionFingerprint,
        afterInspectionFingerprint: after.inspectionFingerprint,
        created,
        rollbackRequest: {
          mode: 'rollback',
          expectedCurrentFingerprint: after.inspectionFingerprint,
          expectedRestoredFingerprint: state.inspectionFingerprint,
          created,
        },
      };
    } catch (error) {
      const rollback = await rollbackCreated(created);
      const restored = await captureState();
      return {
        status: rollback.remaining === 0 && restored.inspectionFingerprint === state.inspectionFingerprint
          ? 'rolled-back'
          : 'rollback-incomplete',
        error: { code: error.code ?? 'APPLY_FAILED', message: error.message },
        createdBeforeFailure: created,
        rollback,
        saved: false,
      };
    }
  }

  async function rollbackCreated(created) {
    const ids = created.map((item) => item.primitiveId).filter(Boolean);
    if (ids.length === 0) return { deleted: true, remaining: 0 };
    let deleted = false;
    try {
      deleted = await eda.sch_PrimitiveComponent.delete(ids);
    } catch {
      deleted = false;
    }
    return { deleted: Boolean(deleted), remaining: 0 };
  }

  const mode = request.mode ?? 'inspect';
  if (mode === 'inspect') {
    const state = await captureState();
    return {
      schemaVersion: 1,
      status: 'inspected',
      readOnly: true,
      state: {
        document: state.document,
        inspectionFingerprint: state.inspectionFingerprint,
        componentCount: state.components.length,
      },
    };
  }
  if (mode === 'apply') {
    const items = normalizeItems(request.items);
    return applyItems(items);
  }
  if (mode === 'verify') {
    if (!Array.isArray(request.created)) {
      fail('INVALID_VERIFY_REQUEST', 'verify requires created readback records.');
    }
    const state = await captureState();
    const byId = new Map(state.components.map((c) => [callGetter(c, 'getState_PrimitiveId'), c]));
    const issues = request.created
      .filter((expected) => !byId.has(expected.primitiveId))
      .map((expected) => ({ code: 'FLAG_MISSING', primitiveId: expected.primitiveId, index: expected.index ?? null }));
    return {
      schemaVersion: 1,
      status: issues.length === 0 ? 'verified' : 'mismatch',
      readOnly: true,
      inspectionFingerprint: state.inspectionFingerprint,
      issues,
    };
  }
  if (mode === 'rollback') {
    if (!request.expectedCurrentFingerprint || !Array.isArray(request.created)) {
      fail('INVALID_ROLLBACK_REQUEST', 'rollback requires current fingerprints and created records.');
    }
    const current = await captureState();
    if (current.inspectionFingerprint !== request.expectedCurrentFingerprint) fail('STALE_ROLLBACK', 'Current schematic differs from the expected applied state.');
    const rollback = await rollbackCreated(request.created);
    const restored = await captureState();
    return {
      schemaVersion: 1,
      status: rollback.remaining === 0 && restored.inspectionFingerprint === request.expectedRestoredFingerprint
        ? 'rolled-back'
        : 'rollback-incomplete',
      rollback,
      restoredInspectionFingerprint: restored.inspectionFingerprint,
      expectedRestoredFingerprint: request.expectedRestoredFingerprint,
      saved: false,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
