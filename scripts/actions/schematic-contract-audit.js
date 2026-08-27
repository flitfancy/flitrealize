return await (async () => {
  const input = flitrealizeInput && typeof flitrealizeInput === 'object' ? flitrealizeInput : {};
  const mode = input.mode ?? 'inspect';
  if (mode !== 'inspect') {
    const error = new Error('schematic-contract-audit supports only inspect mode.');
    error.code = 'UNSUPPORTED_ACTION_MODE';
    throw error;
  }

  const contract = input.contract ?? (input.kind === 'flitrealize.schematic-contract' ? input : null);
  const issues = [];
  const allowedEvidenceStates = new Set(['OPEN', 'CONDITIONAL', 'PASSED']);
  const allowedPinClassifications = new Set([
    'signal',
    'power-in',
    'power-out',
    'ground',
    'passive',
    'no-connect',
    'dnc',
    'thermal',
    'other',
  ]);
  const allowedNetKinds = new Set(['power', 'ground', 'signal', 'clock', 'differential', 'analog', 'other']);
  const allowedDirections = new Set(['input', 'output', 'bidirectional', 'power', 'passive']);
  const allowedTargetKinds = new Set(['project', 'block', 'power-domain', 'interface', 'component', 'pin', 'net']);

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function addIssue(severity, code, path, message) {
    issues.push({ severity, code, path, message });
  }

  function checkUnknownFields(value, allowed, path) {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        addIssue('blocker', 'UNKNOWN_FIELD', `${path}.${key}`, 'Field is not part of SchematicContract v1; use extensions for namespaced data.');
      }
    }
  }

  function nonEmptyString(value, path, required = true) {
    if (typeof value === 'string' && value.trim()) return value;
    if (required || value !== undefined) addIssue('blocker', 'INVALID_STRING', path, 'Expected a non-empty string.');
    return null;
  }

  function booleanValue(value, path) {
    if (typeof value === 'boolean') return value;
    addIssue('blocker', 'INVALID_BOOLEAN', path, 'Expected a boolean.');
    return null;
  }

  function arrayValue(value, path) {
    if (Array.isArray(value)) return value;
    addIssue('blocker', 'INVALID_ARRAY', path, 'Expected an array.');
    return [];
  }

  function objectValue(value, path) {
    if (isObject(value)) return value;
    addIssue('blocker', 'INVALID_OBJECT', path, 'Expected an object.');
    return null;
  }

  function checkStringArray(value, path) {
    const items = arrayValue(value, path);
    const seen = new Set();
    for (let index = 0; index < items.length; index += 1) {
      const item = nonEmptyString(items[index], `${path}[${index}]`);
      if (item && seen.has(item)) addIssue('blocker', 'DUPLICATE_VALUE', `${path}[${index}]`, `Duplicate value ${item}.`);
      if (item) seen.add(item);
    }
    return items;
  }

  function checkExtensions(value, path) {
    if (value !== undefined && !isObject(value)) addIssue('blocker', 'INVALID_EXTENSIONS', path, 'extensions must be an object.');
  }

  function checkEvidenceState(value, path, required = false) {
    if (value === undefined && !required) return null;
    if (!allowedEvidenceStates.has(value)) {
      addIssue('blocker', 'INVALID_EVIDENCE_STATE', path, 'Expected OPEN, CONDITIONAL, or PASSED.');
      return null;
    }
    if (value === 'OPEN') addIssue('open', 'EVIDENCE_OPEN', path, 'Evidence is explicitly open.');
    if (value === 'CONDITIONAL') addIssue('warning', 'EVIDENCE_CONDITIONAL', path, 'Evidence is conditional and requires its bounded revisit test.');
    return value;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'fnv1a32-' + hash.toString(16).padStart(8, '0');
  }

  if (!isObject(contract)) {
    addIssue('blocker', 'CONTRACT_REQUIRED', '$.contract', 'Provide a SchematicContract v1 object as input.contract or as the action input.');
  }

  const root = isObject(contract) ? contract : {};
  checkUnknownFields(root, new Set([
    'kind', 'schemaVersion', 'project', 'blocks', 'powerDomains', 'interfaces',
    'components', 'nets', 'constraints', 'exceptions', 'notes', 'extensions',
  ]), '$');
  if (root.kind !== 'flitrealize.schematic-contract') {
    addIssue('blocker', 'INVALID_CONTRACT_KIND', '$.kind', 'Expected flitrealize.schematic-contract.');
  }
  if (root.schemaVersion !== 1) {
    addIssue('blocker', 'UNSUPPORTED_CONTRACT_VERSION', '$.schemaVersion', 'Expected SchematicContract schemaVersion 1.');
  }
  checkExtensions(root.extensions, '$.extensions');
  if (root.notes !== undefined) checkStringArray(root.notes, '$.notes');

  const project = objectValue(root.project, '$.project') ?? {};
  checkUnknownFields(project, new Set(['id', 'revision', 'title', 'sourceArtifacts', 'extensions']), '$.project');
  const projectId = nonEmptyString(project.id, '$.project.id');
  nonEmptyString(project.revision, '$.project.revision');
  if (project.title !== undefined && typeof project.title !== 'string') addIssue('blocker', 'INVALID_STRING', '$.project.title', 'Expected a string.');
  if (project.sourceArtifacts !== undefined) checkStringArray(project.sourceArtifacts, '$.project.sourceArtifacts');
  checkExtensions(project.extensions, '$.project.extensions');

  const blocks = arrayValue(root.blocks, '$.blocks');
  const powerDomains = arrayValue(root.powerDomains, '$.powerDomains');
  const interfaces = arrayValue(root.interfaces, '$.interfaces');
  const components = arrayValue(root.components, '$.components');
  const nets = arrayValue(root.nets, '$.nets');
  const constraints = arrayValue(root.constraints, '$.constraints');
  const exceptions = arrayValue(root.exceptions, '$.exceptions');

  function uniqueMap(items, getKey, path, label) {
    const result = new Map();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!isObject(item)) {
        addIssue('blocker', 'INVALID_OBJECT', `${path}[${index}]`, `Expected a ${label} object.`);
        continue;
      }
      const key = getKey(item, index);
      if (!key) continue;
      if (result.has(key)) addIssue('blocker', 'DUPLICATE_IDENTITY', `${path}[${index}]`, `Duplicate ${label} identity ${key}.`);
      else result.set(key, { item, index });
    }
    return result;
  }

  const componentMap = uniqueMap(
    components,
    (component, index) => nonEmptyString(component.designator, `$.components[${index}].designator`),
    '$.components',
    'component',
  );
  let pinCount = 0;
  let exactIdentityCount = 0;
  let exactFootprintCount = 0;
  let opaqueProviderBindingCount = 0;
  const pinMap = new Map();

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (!isObject(component)) continue;
    const path = `$.components[${index}]`;
    checkUnknownFields(component, new Set([
      'designator', 'role', 'identity', 'footprint', 'pinMapCoverage', 'pins',
      'includeInBom', 'includeInPcb', 'evidenceState', 'bindings', 'extensions',
    ]), path);
    const designator = typeof component.designator === 'string' && component.designator.trim() ? component.designator : null;
    nonEmptyString(component.role, `${path}.role`);
    const includeInBom = booleanValue(component.includeInBom, `${path}.includeInBom`);
    const includeInPcb = booleanValue(component.includeInPcb, `${path}.includeInPcb`);
    checkEvidenceState(component.evidenceState, `${path}.evidenceState`);
    checkExtensions(component.extensions, `${path}.extensions`);

    const identity = objectValue(component.identity, `${path}.identity`) ?? {};
    checkUnknownFields(identity, new Set(['selection', 'manufacturer', 'mpn', 'value', 'description', 'substitutions', 'extensions']), `${path}.identity`);
    const identitySelection = identity.selection;
    if (!['exact', 'generic', 'unresolved'].includes(identitySelection)) {
      addIssue('blocker', 'INVALID_IDENTITY_SELECTION', `${path}.identity.selection`, 'Expected exact, generic, or unresolved.');
    } else if (identitySelection === 'exact') {
      exactIdentityCount += 1;
      nonEmptyString(identity.mpn, `${path}.identity.mpn`);
    } else if (identitySelection === 'generic') {
      if (!(typeof identity.value === 'string' && identity.value.trim()) && !(typeof identity.description === 'string' && identity.description.trim())) {
        addIssue('blocker', 'GENERIC_IDENTITY_UNBOUNDED', `${path}.identity`, 'A generic identity needs value or description.');
      }
    } else if (identitySelection === 'unresolved') {
      addIssue('open', 'IDENTITY_UNRESOLVED', `${path}.identity.selection`, 'Component identity remains unresolved.');
    }
    for (const key of ['manufacturer', 'mpn', 'value', 'description']) {
      if (identity[key] !== undefined && typeof identity[key] !== 'string') addIssue('blocker', 'INVALID_STRING', `${path}.identity.${key}`, 'Expected a string.');
    }
    if (identity.substitutions !== undefined) checkStringArray(identity.substitutions, `${path}.identity.substitutions`);
    checkExtensions(identity.extensions, `${path}.identity.extensions`);

    const footprint = objectValue(component.footprint, `${path}.footprint`) ?? {};
    checkUnknownFields(footprint, new Set(['selection', 'name', 'policy', 'extensions']), `${path}.footprint`);
    const footprintSelection = footprint.selection;
    if (!['exact', 'policy', 'unresolved'].includes(footprintSelection)) {
      addIssue('blocker', 'INVALID_FOOTPRINT_SELECTION', `${path}.footprint.selection`, 'Expected exact, policy, or unresolved.');
    } else if (footprintSelection === 'exact') {
      exactFootprintCount += 1;
      nonEmptyString(footprint.name, `${path}.footprint.name`);
    } else if (footprintSelection === 'policy') {
      nonEmptyString(footprint.policy, `${path}.footprint.policy`);
    } else if (footprintSelection === 'unresolved' && includeInPcb !== false) {
      addIssue('open', 'FOOTPRINT_UNRESOLVED', `${path}.footprint.selection`, 'PCB-bound component footprint remains unresolved.');
    }
    checkExtensions(footprint.extensions, `${path}.footprint.extensions`);

    if (!['critical', 'complete'].includes(component.pinMapCoverage)) {
      addIssue('blocker', 'INVALID_PIN_MAP_COVERAGE', `${path}.pinMapCoverage`, 'Expected critical or complete.');
    }
    const pins = arrayValue(component.pins, `${path}.pins`);
    if (includeInPcb === true && pins.length === 0) {
      addIssue('warning', 'PCB_COMPONENT_WITHOUT_PINS', `${path}.pins`, 'PCB-bound component has no declared pins.');
    }
    const localPins = new Set();
    for (let pinIndex = 0; pinIndex < pins.length; pinIndex += 1) {
      const pin = pins[pinIndex];
      const pinPath = `${path}.pins[${pinIndex}]`;
      if (!isObject(pin)) {
        addIssue('blocker', 'INVALID_OBJECT', pinPath, 'Expected a pin object.');
        continue;
      }
      checkUnknownFields(pin, new Set(['number', 'function', 'classification', 'safeDefault', 'notes', 'extensions']), pinPath);
      const number = nonEmptyString(pin.number, `${pinPath}.number`);
      nonEmptyString(pin.function, `${pinPath}.function`);
      if (!allowedPinClassifications.has(pin.classification)) {
        addIssue('blocker', 'INVALID_PIN_CLASSIFICATION', `${pinPath}.classification`, 'Unknown pin classification.');
      }
      if (pin.safeDefault !== undefined && typeof pin.safeDefault !== 'string') addIssue('blocker', 'INVALID_STRING', `${pinPath}.safeDefault`, 'Expected a string.');
      if (pin.notes !== undefined) checkStringArray(pin.notes, `${pinPath}.notes`);
      checkExtensions(pin.extensions, `${pinPath}.extensions`);
      if (number && localPins.has(number)) addIssue('blocker', 'DUPLICATE_PIN_NUMBER', `${pinPath}.number`, `Duplicate pin ${number} on ${designator ?? 'component'}.`);
      if (number) localPins.add(number);
      if (designator && number) {
        pinMap.set(`${designator}.${number}`, { classification: pin.classification, path: pinPath });
      }
      pinCount += 1;
    }

    if (component.bindings !== undefined) {
      if (!isObject(component.bindings)) {
        addIssue('blocker', 'INVALID_BINDINGS', `${path}.bindings`, 'bindings must be a Provider-keyed object.');
      } else {
        for (const [provider, binding] of Object.entries(component.bindings)) {
          if (!/^[a-z][a-zA-Z0-9]*$/.test(provider) || !isObject(binding)) {
            addIssue('blocker', 'INVALID_PROVIDER_BINDING', `${path}.bindings.${provider}`, 'Provider binding must use a namespaced object.');
          } else {
            opaqueProviderBindingCount += 1;
          }
        }
      }
    }
  }

  const netMap = uniqueMap(
    nets,
    (net, index) => nonEmptyString(net.name, `$.nets[${index}].name`),
    '$.nets',
    'net',
  );
  let endpointCount = 0;
  const endpointOwners = new Map();
  for (let index = 0; index < nets.length; index += 1) {
    const net = nets[index];
    if (!isObject(net)) continue;
    const path = `$.nets[${index}]`;
    checkUnknownFields(net, new Set(['name', 'kind', 'powerDomain', 'differentialMate', 'endpoints', 'extensions']), path);
    const netName = typeof net.name === 'string' && net.name.trim() ? net.name : `#${index}`;
    if (!allowedNetKinds.has(net.kind)) addIssue('blocker', 'INVALID_NET_KIND', `${path}.kind`, 'Unknown net kind.');
    if (net.powerDomain !== undefined) nonEmptyString(net.powerDomain, `${path}.powerDomain`);
    if (net.differentialMate !== undefined) nonEmptyString(net.differentialMate, `${path}.differentialMate`);
    checkExtensions(net.extensions, `${path}.extensions`);
    const endpoints = arrayValue(net.endpoints, `${path}.endpoints`);
    if (endpoints.length === 0) addIssue('blocker', 'NET_WITHOUT_ENDPOINTS', `${path}.endpoints`, 'A contract net needs at least one endpoint.');
    const localEndpoints = new Set();
    for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex += 1) {
      const endpoint = endpoints[endpointIndex];
      const endpointPath = `${path}.endpoints[${endpointIndex}]`;
      if (!isObject(endpoint)) {
        addIssue('blocker', 'INVALID_OBJECT', endpointPath, 'Expected an endpoint object.');
        continue;
      }
      checkUnknownFields(endpoint, new Set(['component', 'pin']), endpointPath);
      const designator = nonEmptyString(endpoint.component, `${endpointPath}.component`);
      const pin = nonEmptyString(endpoint.pin, `${endpointPath}.pin`);
      if (!designator || !pin) continue;
      const endpointId = `${designator}.${pin}`;
      if (localEndpoints.has(endpointId)) addIssue('blocker', 'DUPLICATE_NET_ENDPOINT', endpointPath, `${endpointId} appears twice on ${netName}.`);
      localEndpoints.add(endpointId);
      if (endpointOwners.has(endpointId) && endpointOwners.get(endpointId) !== netName) {
        addIssue('blocker', 'ENDPOINT_ON_MULTIPLE_NETS', endpointPath, `${endpointId} is assigned to both ${endpointOwners.get(endpointId)} and ${netName}.`);
      } else {
        endpointOwners.set(endpointId, netName);
      }
      if (!componentMap.has(designator)) {
        addIssue('blocker', 'UNKNOWN_COMPONENT_REFERENCE', `${endpointPath}.component`, `Component ${designator} is not declared.`);
      } else if (!pinMap.has(endpointId)) {
        addIssue('blocker', 'UNKNOWN_PIN_REFERENCE', endpointPath, `Pin ${endpointId} is not declared in the component pin map.`);
      } else if (['no-connect', 'dnc'].includes(pinMap.get(endpointId).classification)) {
        addIssue('blocker', 'FORBIDDEN_PIN_CONNECTED', endpointPath, `${endpointId} is classified ${pinMap.get(endpointId).classification} but is assigned to ${netName}.`);
      }
      endpointCount += 1;
    }
  }

  const powerDomainMap = uniqueMap(
    powerDomains,
    (domain, index) => nonEmptyString(domain.id, `$.powerDomains[${index}].id`),
    '$.powerDomains',
    'power domain',
  );
  for (let index = 0; index < powerDomains.length; index += 1) {
    const domain = powerDomains[index];
    if (!isObject(domain)) continue;
    const path = `$.powerDomains[${index}]`;
    checkUnknownFields(domain, new Set([
      'id', 'nominalVoltageV', 'minimumVoltageV', 'maximumVoltageV',
      'sourceNet', 'returnNet', 'evidenceState', 'extensions',
    ]), path);
    const sourceNet = nonEmptyString(domain.sourceNet, `${path}.sourceNet`);
    const returnNet = nonEmptyString(domain.returnNet, `${path}.returnNet`);
    for (const key of ['nominalVoltageV', 'minimumVoltageV', 'maximumVoltageV']) {
      if (domain[key] !== undefined && typeof domain[key] !== 'number') addIssue('blocker', 'INVALID_NUMBER', `${path}.${key}`, 'Expected a number.');
    }
    if (typeof domain.minimumVoltageV === 'number' && typeof domain.maximumVoltageV === 'number' && domain.minimumVoltageV > domain.maximumVoltageV) {
      addIssue('blocker', 'INVALID_VOLTAGE_RANGE', path, 'minimumVoltageV exceeds maximumVoltageV.');
    }
    if (sourceNet && !netMap.has(sourceNet)) addIssue('blocker', 'UNKNOWN_NET_REFERENCE', `${path}.sourceNet`, `Net ${sourceNet} is not declared.`);
    if (returnNet && !netMap.has(returnNet)) addIssue('blocker', 'UNKNOWN_NET_REFERENCE', `${path}.returnNet`, `Net ${returnNet} is not declared.`);
    if (sourceNet && returnNet && sourceNet === returnNet) addIssue('blocker', 'POWER_RETURN_EQUALS_SOURCE', path, 'Power source and return nets must differ.');
    checkEvidenceState(domain.evidenceState, `${path}.evidenceState`);
    checkExtensions(domain.extensions, `${path}.extensions`);
  }

  for (const [netName, record] of netMap) {
    const net = record.item;
    const path = `$.nets[${record.index}]`;
    if (net.powerDomain && !powerDomainMap.has(net.powerDomain)) {
      addIssue('blocker', 'UNKNOWN_POWER_DOMAIN_REFERENCE', `${path}.powerDomain`, `Power domain ${net.powerDomain} is not declared.`);
    }
    if (net.differentialMate) {
      const mate = netMap.get(net.differentialMate)?.item;
      if (!mate) addIssue('blocker', 'UNKNOWN_DIFFERENTIAL_MATE', `${path}.differentialMate`, `Net ${net.differentialMate} is not declared.`);
      else if (mate.differentialMate !== netName) addIssue('blocker', 'ASYMMETRIC_DIFFERENTIAL_PAIR', `${path}.differentialMate`, `Differential mate ${net.differentialMate} does not point back to ${netName}.`);
    }
  }

  const blockMap = uniqueMap(
    blocks,
    (block, index) => nonEmptyString(block.id, `$.blocks[${index}].id`),
    '$.blocks',
    'block',
  );
  const assignedComponents = new Set();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!isObject(block)) continue;
    const path = `$.blocks[${index}]`;
    checkUnknownFields(block, new Set(['id', 'purpose', 'components', 'evidenceState', 'notes', 'extensions']), path);
    nonEmptyString(block.purpose, `${path}.purpose`);
    const members = checkStringArray(block.components, `${path}.components`);
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      const member = members[memberIndex];
      if (typeof member !== 'string' || !member.trim()) continue;
      assignedComponents.add(member);
      if (!componentMap.has(member)) addIssue('blocker', 'UNKNOWN_COMPONENT_REFERENCE', `${path}.components[${memberIndex}]`, `Component ${member} is not declared.`);
    }
    checkEvidenceState(block.evidenceState, `${path}.evidenceState`);
    if (block.notes !== undefined) checkStringArray(block.notes, `${path}.notes`);
    checkExtensions(block.extensions, `${path}.extensions`);
  }
  for (const designator of componentMap.keys()) {
    if (!assignedComponents.has(designator)) addIssue('warning', 'COMPONENT_WITHOUT_BLOCK', '$.blocks', `Component ${designator} is not assigned to a functional block.`);
  }

  const interfaceMap = uniqueMap(
    interfaces,
    (entry, index) => nonEmptyString(entry.id, `$.interfaces[${index}].id`),
    '$.interfaces',
    'interface',
  );
  for (let index = 0; index < interfaces.length; index += 1) {
    const entry = interfaces[index];
    if (!isObject(entry)) continue;
    const path = `$.interfaces[${index}]`;
    checkUnknownFields(entry, new Set(['id', 'protocol', 'signals', 'evidenceState', 'extensions']), path);
    if (entry.protocol !== undefined && typeof entry.protocol !== 'string') addIssue('blocker', 'INVALID_STRING', `${path}.protocol`, 'Expected a string.');
    const signals = arrayValue(entry.signals, `${path}.signals`);
    const signalNames = new Set();
    for (let signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
      const signal = signals[signalIndex];
      const signalPath = `${path}.signals[${signalIndex}]`;
      if (!isObject(signal)) {
        addIssue('blocker', 'INVALID_OBJECT', signalPath, 'Expected an interface signal object.');
        continue;
      }
      checkUnknownFields(signal, new Set(['name', 'net', 'direction', 'powerDomain', 'safeDefault', 'extensions']), signalPath);
      const name = nonEmptyString(signal.name, `${signalPath}.name`);
      const net = nonEmptyString(signal.net, `${signalPath}.net`);
      if (name && signalNames.has(name)) addIssue('blocker', 'DUPLICATE_INTERFACE_SIGNAL', `${signalPath}.name`, `Duplicate signal ${name}.`);
      if (name) signalNames.add(name);
      if (net && !netMap.has(net)) addIssue('blocker', 'UNKNOWN_NET_REFERENCE', `${signalPath}.net`, `Net ${net} is not declared.`);
      if (!allowedDirections.has(signal.direction)) addIssue('blocker', 'INVALID_INTERFACE_DIRECTION', `${signalPath}.direction`, 'Unknown interface direction.');
      if (signal.powerDomain && !powerDomainMap.has(signal.powerDomain)) addIssue('blocker', 'UNKNOWN_POWER_DOMAIN_REFERENCE', `${signalPath}.powerDomain`, `Power domain ${signal.powerDomain} is not declared.`);
      if (signal.safeDefault !== undefined && typeof signal.safeDefault !== 'string') addIssue('blocker', 'INVALID_STRING', `${signalPath}.safeDefault`, 'Expected a string.');
      checkExtensions(signal.extensions, `${signalPath}.extensions`);
    }
    checkEvidenceState(entry.evidenceState, `${path}.evidenceState`);
    checkExtensions(entry.extensions, `${path}.extensions`);
  }

  const targetSets = {
    project: new Set(projectId ? [projectId] : []),
    block: new Set(blockMap.keys()),
    'power-domain': new Set(powerDomainMap.keys()),
    interface: new Set(interfaceMap.keys()),
    component: new Set(componentMap.keys()),
    pin: new Set(pinMap.keys()),
    net: new Set(netMap.keys()),
  };

  function checkTargets(value, path) {
    const targets = arrayValue(value, path);
    if (targets.length === 0) addIssue('blocker', 'EMPTY_TARGET_SET', path, 'At least one target is required.');
    const seen = new Set();
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const targetPath = `${path}[${index}]`;
      if (!isObject(target)) {
        addIssue('blocker', 'INVALID_OBJECT', targetPath, 'Expected a target object.');
        continue;
      }
      checkUnknownFields(target, new Set(['kind', 'id']), targetPath);
      if (!allowedTargetKinds.has(target.kind)) {
        addIssue('blocker', 'INVALID_TARGET_KIND', `${targetPath}.kind`, 'Unknown target kind.');
        continue;
      }
      const id = nonEmptyString(target.id, `${targetPath}.id`);
      if (!id) continue;
      const key = `${target.kind}:${id}`;
      if (seen.has(key)) addIssue('blocker', 'DUPLICATE_TARGET', targetPath, `Duplicate target ${key}.`);
      seen.add(key);
      if (!targetSets[target.kind].has(id)) addIssue('blocker', 'UNKNOWN_TARGET', targetPath, `Target ${key} is not declared.`);
    }
  }

  function checkEvidenceRefs(entry, path) {
    const refs = entry.evidenceRefs === undefined ? [] : checkStringArray(entry.evidenceRefs, `${path}.evidenceRefs`);
    if (entry.evidenceState === 'PASSED' && refs.length === 0) {
      addIssue('warning', 'PASSED_WITHOUT_EVIDENCE_REF', `${path}.evidenceRefs`, 'PASSED state should retain at least one evidence reference.');
    }
  }

  uniqueMap(
    constraints,
    (constraint, index) => nonEmptyString(constraint.id, `$.constraints[${index}].id`),
    '$.constraints',
    'constraint',
  );
  for (let index = 0; index < constraints.length; index += 1) {
    const constraint = constraints[index];
    if (!isObject(constraint)) continue;
    const path = `$.constraints[${index}]`;
    checkUnknownFields(constraint, new Set(['id', 'type', 'appliesTo', 'requirement', 'evidenceState', 'evidenceRefs', 'extensions']), path);
    nonEmptyString(constraint.type, `${path}.type`);
    nonEmptyString(constraint.requirement, `${path}.requirement`);
    checkTargets(constraint.appliesTo, `${path}.appliesTo`);
    checkEvidenceState(constraint.evidenceState, `${path}.evidenceState`, true);
    checkEvidenceRefs(constraint, path);
    checkExtensions(constraint.extensions, `${path}.extensions`);
  }

  uniqueMap(
    exceptions,
    (exception, index) => nonEmptyString(exception.id, `$.exceptions[${index}].id`),
    '$.exceptions',
    'exception',
  );
  for (let index = 0; index < exceptions.length; index += 1) {
    const exception = exceptions[index];
    if (!isObject(exception)) continue;
    const path = `$.exceptions[${index}]`;
    checkUnknownFields(exception, new Set(['id', 'rule', 'appliesTo', 'rationale', 'evidenceState', 'evidenceRefs', 'extensions']), path);
    nonEmptyString(exception.rule, `${path}.rule`);
    nonEmptyString(exception.rationale, `${path}.rationale`);
    checkTargets(exception.appliesTo, `${path}.appliesTo`);
    checkEvidenceState(exception.evidenceState, `${path}.evidenceState`, true);
    checkEvidenceRefs(exception, path);
    checkExtensions(exception.extensions, `${path}.extensions`);
  }

  const blockerCount = issues.filter((issue) => issue.severity === 'blocker').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const openCount = issues.filter((issue) => issue.severity === 'open').length;
  const status = blockerCount > 0 ? 'blocked' : (warningCount > 0 || openCount > 0 ? 'conditional' : 'passed');
  const fingerprint = hashText(stableStringify(root));

  return {
    schemaVersion: 1,
    kind: 'flitrealize.schematic-contract-audit',
    status,
    readOnly: true,
    fingerprint,
    project: {
      id: projectId,
      revision: typeof project.revision === 'string' ? project.revision : null,
    },
    counts: {
      blockCount: blocks.length,
      powerDomainCount: powerDomains.length,
      interfaceCount: interfaces.length,
      componentCount: components.length,
      pinCount,
      netCount: nets.length,
      endpointCount,
      constraintCount: constraints.length,
      exceptionCount: exceptions.length,
      exactIdentityCount,
      exactFootprintCount,
      opaqueProviderBindingCount,
      issueCount: issues.length,
      blockerCount,
      warningCount,
      openCount,
    },
    coverage: {
      contractShapeChecked: true,
      crossReferencesChecked: true,
      providerBindings: 'opaque',
      electricalCorrectness: false,
      realizedSchematicComparison: false,
    },
    issues,
    unsupported: [],
    conclusion: status === 'passed'
      ? 'Contract structure and declared cross-references are internally consistent.'
      : status === 'conditional'
        ? 'Contract structure is usable, with explicit open or conditional evidence to resolve.'
        : 'Contract has structural or reference blockers and must not drive schematic writes.',
  };
})();
