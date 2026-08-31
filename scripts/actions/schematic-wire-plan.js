return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;
  const DEFAULT_STUB_LENGTH = 8;
  const DEFAULT_CONNECTION_TOLERANCE = 0.1;
  const DEFAULT_GRID = 1;
  const MAX_STUB_LENGTH = 1000;

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

  function finitePosition(value) {
    return value && Number.isFinite(value.x) && Number.isFinite(value.y)
      ? { x: Number(value.x), y: Number(value.y) }
      : null;
  }

  function normalizePoints(value) {
    if (!Array.isArray(value)) return [];
    if (value.every((entry) => Number.isFinite(Number(entry)))) {
      const points = [];
      for (let index = 0; index + 1 < value.length; index += 2) {
        points.push({ x: Number(value[index]), y: Number(value[index + 1]) });
      }
      return points;
    }
    return value.map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2 && Number.isFinite(Number(entry[0])) && Number.isFinite(Number(entry[1]))) {
        return { x: Number(entry[0]), y: Number(entry[1]) };
      }
      if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) return { x: Number(entry.x), y: Number(entry.y) };
      return null;
    }).filter(Boolean);
  }

  function pointDistance(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y);
  }

  function pointToSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return pointDistance(point, start);
    const projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
    const t = Math.max(0, Math.min(1, projection));
    return pointDistance(point, { x: start.x + t * dx, y: start.y + t * dy });
  }

  function snap(value, grid) {
    return Math.round(value / grid) * grid;
  }

  function validateInputs(contract, snapshot, placementPlan) {
    if (!contract || contract.kind !== 'flitrealize.schematic-contract' || contract.schemaVersion !== 1) {
      fail('INVALID_CONTRACT', 'A SchematicContract v1 object is required.');
    }
    if (!snapshot || snapshot.kind !== 'flitrealize.schematic-snapshot' || snapshot.schemaVersion !== 1) {
      fail('INVALID_SNAPSHOT', 'A SchematicSnapshot v1 object is required.');
    }
    if (snapshot.provider !== 'easyeda-pro') {
      fail('SNAPSHOT_PROVIDER_MISMATCH', 'Wire planning requires a live easyeda-pro snapshot.');
    }
    if (!snapshot.document?.nativeId || !snapshot.fingerprints?.document) {
      fail('INVALID_SNAPSHOT', 'Snapshot document identity and document fingerprint are required.');
    }
    if (placementPlan !== undefined && (
      !placementPlan
      || placementPlan.kind !== 'flitrealize.schematic-placement-plan'
      || placementPlan.schemaVersion !== 1
      || placementPlan.targetProvider !== 'easyeda-pro'
      || !Array.isArray(placementPlan.components)
    )) {
      fail('INVALID_PLACEMENT_PLAN', 'placementPlan must be an EasyEDA SchematicPlacementPlan v1.');
    }
  }

  function snapshotWireEvidence(snapshot) {
    return (snapshot.extensions?.easyedaPro?.wires || []).map((wire) => ({
      primitiveId: wire.primitiveId ?? null,
      net: typeof wire.net === 'string' ? wire.net : '',
      points: normalizePoints(wire.points ?? wire.line),
      lineWidth: Number.isFinite(wire.lineWidth) ? wire.lineWidth : null,
      lineType: wire.lineType ?? null,
    })).sort((left, right) => String(left.primitiveId).localeCompare(String(right.primitiveId)));
  }

  function geometryEvidence(snapshot) {
    return {
      components: (Array.isArray(snapshot.components) ? snapshot.components : [])
        .map((component) => ({
          designator: component.designator,
          nativeId: component.nativeId,
          position: finitePosition(component.position),
          rotation: Number.isFinite(component.rotation) ? component.rotation : null,
          mirror: component.mirror === true,
          pins: (Array.isArray(component.pins) ? component.pins : [])
            .map((pin) => ({
              number: String(pin.number),
              nativeId: pin.nativeId,
              position: finitePosition(pin.position),
              rotation: Number.isFinite(pin.extensions?.easyedaPro?.rotation)
                ? pin.extensions.easyedaPro.rotation
                : null,
              noConnect: pin.noConnect === true,
            }))
            .sort((left, right) => left.number.localeCompare(right.number)),
        }))
        .sort((left, right) => String(left.designator).localeCompare(String(right.designator))),
      wires: snapshotWireEvidence(snapshot),
    };
  }

  function outwardVector(componentPosition, pinPosition) {
    const dx = pinPosition.x - componentPosition.x;
    const dy = pinPosition.y - componentPosition.y;
    if (dx === 0 && dy === 0) return null;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
    return { x: 0, y: Math.sign(dy) || 1 };
  }

  function orthogonalStubEnd(pinPosition, direction, stubLength, grid) {
    if (direction.x !== 0) {
      return {
        x: snap(pinPosition.x + direction.x * stubLength, grid),
        y: pinPosition.y,
      };
    }
    return {
      x: pinPosition.x,
      y: snap(pinPosition.y + direction.y * stubLength, grid),
    };
  }

  function providerPins(contractComponent, plannedComponent, contractPin) {
    const mapped = plannedComponent?.bindings?.easyedaPro?.pinMap?.[String(contractPin)]
      ?? contractComponent.bindings?.easyedaPro?.pinMap?.[String(contractPin)];
    if (mapped === undefined || mapped === null) return [String(contractPin)];
    const source = Array.isArray(mapped) ? mapped : [mapped];
    return [...new Set(source.map((value) => String(value).trim()).filter(Boolean))];
  }

  function wireTouches(position, points, tolerance) {
    if (points.some((point) => pointDistance(point, position) <= tolerance)) return true;
    for (let index = 0; index + 1 < points.length; index += 1) {
      if (pointToSegmentDistance(position, points[index], points[index + 1]) <= tolerance) return true;
    }
    return false;
  }

  function wiresTouching(position, wireEvidence, tolerance) {
    return wireEvidence.filter((wire) => wireTouches(position, wire.points, tolerance));
  }

  function buildWirePlan(contract, snapshot, placementPlan, stubLength, connectionTolerance, grid) {
    const unresolved = [];
    const existingEndpoints = [];
    if (placementPlan) {
      if (!placementPlan.fingerprints?.plan || !placementPlan.fingerprints?.bindings) {
        unresolved.push({
          code: 'PLACEMENT_PLAN_FINGERPRINTS_REQUIRED',
          message: 'PlacementPlan plan and binding fingerprints are required for connection planning.',
        });
      }
      if (
        placementPlan.project?.id
        && contract.project?.id
        && placementPlan.project.id !== contract.project.id
      ) {
        unresolved.push({
          code: 'CONTRACT_PLACEMENT_PROJECT_MISMATCH',
          message: `Contract project ${contract.project.id} does not match PlacementPlan project ${placementPlan.project.id}.`,
        });
      }
      const placementErrors = (placementPlan.diagnostics || []).filter((diagnostic) => diagnostic?.severity === 'error');
      if (placementErrors.length) {
        unresolved.push({
          code: 'SOURCE_PLACEMENT_PLAN_BLOCKED',
          message: `PlacementPlan contains ${placementErrors.length} blocking diagnostic(s).`,
        });
      }
    }
    const componentsByDesignator = new Map();
    for (const component of snapshot.components || []) {
      const designator = typeof component.designator === 'string' ? component.designator : '';
      if (!designator) continue;
      if (componentsByDesignator.has(designator)) {
        unresolved.push({
          code: 'DUPLICATE_SNAPSHOT_DESIGNATOR',
          message: `Snapshot contains more than one ${designator}.`,
          component: designator,
        });
      } else {
        componentsByDesignator.set(designator, component);
      }
    }
    const contractByDesignator = new Map((contract.components || []).map((component) => [component.designator, component]));
    const plannedByDesignator = new Map((placementPlan?.components || []).map((component) => [component.designator, component]));
    const liveWires = snapshotWireEvidence(snapshot);
    const wires = [];
    const seen = new Set();
    for (const net of contract.nets || []) {
      for (const endpoint of net.endpoints || []) {
        const componentName = String(endpoint.component || '');
        const contractPin = String(endpoint.pin || '');
        const contractComponent = contractByDesignator.get(componentName);
        const component = componentsByDesignator.get(componentName);
        if (!contractComponent) {
          unresolved.push({ code: 'CONTRACT_COMPONENT_MISSING', message: `${componentName} is absent from Contract components.`, component: componentName, pin: contractPin, net: net.name });
          continue;
        }
        if (!component) {
          unresolved.push({ code: 'COMPONENT_NOT_REALIZED', message: `${componentName} is absent from the live Snapshot.`, component: componentName, pin: contractPin, net: net.name });
          continue;
        }
        const mappedPins = providerPins(contractComponent, plannedByDesignator.get(componentName), contractPin);
        if (!mappedPins.length) {
          unresolved.push({ code: 'PIN_MAP_EMPTY', message: `${componentName}.${contractPin} has an empty EasyEDA pin mapping.`, component: componentName, pin: contractPin, net: net.name });
          continue;
        }
        for (const providerPin of mappedPins) {
          const key = `${net.name}:${componentName}:${contractPin}:${providerPin}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pin = (component.pins || []).find((item) => String(item.number) === providerPin);
          if (!pin) {
            unresolved.push({
              code: 'PIN_NOT_REALIZED',
              message: `${componentName}.${contractPin} maps to EasyEDA pin ${providerPin}, which is absent from the live Snapshot.`,
              component: componentName,
              pin: contractPin,
              providerPin,
              net: net.name,
            });
            continue;
          }
          if (pin.noConnect === true) {
            unresolved.push({ code: 'NO_CONNECT_ENDPOINT', message: `${componentName}.${contractPin} (EasyEDA ${providerPin}) is marked no-connect.`, component: componentName, pin: contractPin, providerPin, net: net.name });
            continue;
          }
          const componentPosition = finitePosition(component.position);
          const pinPosition = finitePosition(pin.position);
          if (!componentPosition || !pinPosition) {
            unresolved.push({ code: 'PIN_POSITION_UNRESOLVED', message: `${componentName}.${contractPin} lacks live component or pin coordinates.`, component: componentName, pin: contractPin, providerPin, net: net.name });
            continue;
          }
          const touching = wiresTouching(pinPosition, liveWires, connectionTolerance);
          const matching = touching.filter((wire) => wire.net === net.name);
          if (matching.length) {
            existingEndpoints.push({
              key,
              net: net.name,
              component: componentName,
              pin: contractPin,
              providerPin,
              nativePinId: pin.nativeId,
              wireIds: matching.map((wire) => wire.primitiveId).filter(Boolean),
            });
            continue;
          }
          const conflicting = touching.filter((wire) => wire.net && wire.net !== net.name);
          if (conflicting.length) {
            unresolved.push({
              code: 'EXISTING_WIRE_NET_MISMATCH',
              message: `${componentName}.${contractPin} already touches wire net(s) ${[...new Set(conflicting.map((wire) => wire.net))].join(', ')} instead of ${net.name}.`,
              component: componentName,
              pin: contractPin,
              providerPin,
              net: net.name,
            });
            continue;
          }
          if (touching.length) {
            unresolved.push({
              code: 'EXISTING_WIRE_NET_UNKNOWN',
              message: `${componentName}.${contractPin} already touches an unnamed wire; connectivity must be resolved before creating another stub.`,
              component: componentName,
              pin: contractPin,
              providerPin,
              net: net.name,
            });
            continue;
          }
          const direction = outwardVector(componentPosition, pinPosition);
          if (!direction) {
            unresolved.push({ code: 'PIN_DIRECTION_UNRESOLVED', message: `${componentName}.${contractPin} is coincident with the component anchor.`, component: componentName, pin: contractPin, providerPin, net: net.name });
            continue;
          }
          wires.push({
            key,
            net: net.name,
            endpoint: {
              component: componentName,
              pin: contractPin,
              providerPin,
              nativePinId: pin.nativeId,
            },
            points: [
              pinPosition,
              orthogonalStubEnd(pinPosition, direction, stubLength, grid),
            ],
          });
        }
      }
    }

    const contractFingerprint = hashText(stableStringify(contract));
    const geometryFingerprint = hashText(stableStringify(geometryEvidence(snapshot)));
    const source = {
      contractFingerprint,
      placementPlanFingerprint: placementPlan?.fingerprints?.plan ?? null,
      bindingFingerprint: placementPlan?.fingerprints?.bindings ?? null,
      snapshotFingerprint: snapshot.fingerprints.document,
      geometryFingerprint,
    };
    const planFingerprint = hashText(stableStringify({
      provider: snapshot.provider,
      documentUuid: snapshot.document.nativeId,
      source,
      stubLength,
      connectionTolerance,
      grid,
      wires,
      existingEndpoints,
      unresolved,
    }));
    return {
      kind: 'flitrealize.schematic-wire-plan',
      schemaVersion: 1,
      provider: 'easyeda-pro',
      generatedAt: new Date().toISOString(),
      project: {
        id: snapshot.project.id,
        nativeId: snapshot.project.nativeId,
        name: snapshot.project.name || '',
      },
      document: {
        id: snapshot.document.id,
        nativeId: snapshot.document.nativeId,
        type: 'schematic',
        revision: snapshot.document.revision || '',
      },
      source,
      stubLength,
      connectionTolerance,
      grid,
      wires,
      unresolved,
      fingerprints: { plan: planFingerprint },
      extensions: {
        generation: {
          directionBasis: 'component-to-pin-dominant-axis',
          contactBasis: 'point-to-polyline-distance',
          creates: 'one orthogonal stub per unresolved physical endpoint',
          existingEndpointCount: existingEndpoints.length,
          existingEndpoints,
        },
      },
    };
  }

  const mode = request.mode ?? 'inspect';
  const contract = request.contract;
  const snapshot = request.snapshot;
  const placementPlan = request.placementPlan;
  validateInputs(contract, snapshot, placementPlan);
  const stubLength = request.stubLength ?? DEFAULT_STUB_LENGTH;
  if (!Number.isFinite(stubLength) || stubLength <= 0 || stubLength > MAX_STUB_LENGTH) {
    fail('INVALID_STUB_LENGTH', `stubLength must be greater than 0 and no more than ${MAX_STUB_LENGTH}.`);
  }
  const connectionTolerance = request.connectionTolerance ?? DEFAULT_CONNECTION_TOLERANCE;
  if (!Number.isFinite(connectionTolerance) || connectionTolerance < 0 || connectionTolerance > 10) {
    fail('INVALID_CONNECTION_TOLERANCE', 'connectionTolerance must be between 0 and 10.');
  }
  const grid = request.grid ?? DEFAULT_GRID;
  if (!Number.isFinite(grid) || grid <= 0 || grid > 100) fail('INVALID_GRID', 'grid must be greater than 0 and no more than 100.');
  const wirePlan = buildWirePlan(contract, snapshot, placementPlan, stubLength, connectionTolerance, grid);
  const existingEndpointCount = wirePlan.extensions.generation.existingEndpointCount;

  if (mode === 'inspect') {
    return {
      schemaVersion: 2,
      status: wirePlan.unresolved.length === 0 ? 'inspected' : 'inspected-with-gaps',
      readOnly: true,
      document: snapshot.document,
      componentCount: (snapshot.components || []).length,
      netCount: (contract.nets || []).length,
      plannedWireCount: wirePlan.wires.length,
      existingEndpointCount,
      unresolvedCount: wirePlan.unresolved.length,
      unresolved: wirePlan.unresolved,
      sourceGeometryFingerprint: wirePlan.source.geometryFingerprint,
    };
  }
  if (mode === 'generate') {
    return {
      schemaVersion: 2,
      status: wirePlan.unresolved.length === 0 ? 'generated' : 'generated-with-blockers',
      readOnly: true,
      wirePlan,
      wireCount: wirePlan.wires.length,
      existingEndpointCount,
      unresolvedCount: wirePlan.unresolved.length,
      unresolved: wirePlan.unresolved,
      sourceGeometryFingerprint: wirePlan.source.geometryFingerprint,
      planFingerprint: wirePlan.fingerprints.plan,
    };
  }
  fail('INVALID_MODE', `Unsupported mode: ${mode}`);
})();
