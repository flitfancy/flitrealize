import { compileModel, validateWeights } from './pcb-layout-solver-core.mjs';
import { layoutInputModel } from './pcb-layout-input-model.mjs';
import { padOwner } from './pcb-layout-geometry.mjs';
import { auditNativeNetlist } from './pcb-layout-netlist.mjs';
import { nativeObservations } from './pcb-layout-observations.mjs';
import { layoutRealization } from './pcb-layout-provider.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const relationGroup = { bypass: 'bypass', bootstrap: 'bypass', sense: 'sense', 'power-path': 'power' };
const boxValid = b => object(b) && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) && b.maxX > b.minX && b.maxY > b.minY;
const pairKey = (a, aPin, b, bPin, net) => JSON.stringify([[a, String(aPin ?? '*')], [b, String(bPin ?? '*')]].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))).concat([net]));
const hasErrors = diagnostics => diagnostics.some(d => d.severity === 'error');

/** Pure preparation: snapshot poses remain authoritative. It compiles explicit
 * intent, never searches, repairs, writes EDA, or interprets prose as a rule. */
export function prepareLayoutInputs(input = {}) {
  const diagnostics = [], coverage = { relations: [], requirements: [], explicitRules: [], limitations: ['Distances are pad-centre Manhattan proxies, not routed lengths.', 'Assembly geometry is only as reliable as its supplied shapes and rules.', 'Routing, return paths, Kelvin pickup, thermal and EMI performance are not evaluated.'] };
  const issue = (category, code, path, message, severity = 'error') => diagnostics.push({ category, code, path, message, severity });
  let snapshot, contract, config, mechanical, realization;
  try { ({ snapshot, contract, config, mechanical } = structuredClone(input)); }
  catch (error) { issue('structure', 'INPUT_NOT_CLONEABLE', '', error.message); }
  const scope = { included: [], excluded: [], missing: [], pcbOnly: [], excludedPresent: [], standalonePads: [] };
  const assessed = { identity: false, support: false };
  const source = { units: snapshot?.units === undefined ? 'provider-convention' : 'snapshot', coordinateSystem: snapshot?.coordinateSystem === undefined ? 'provider-convention' : 'snapshot', providerCapabilities: snapshot?.capabilities === undefined ? 'not-recorded' : 'snapshot', contractRevision: contract?.project?.revision ?? null, snapshotSourceHash: snapshot?.sourceHash ?? null };
  let model, nativeNetwork = { status: 'not-evaluated', counts: {} };
  const finish = () => {
    const errors = category => diagnostics.some(d => d.category === category && d.severity === 'error');
    const state = {
      input: ['structure', 'semantic', 'compile'].some(errors) ? 'invalid' : 'valid',
      identity: errors('identity') ? 'mismatch' : (model ? 'matched' : 'unknown'),
      support: errors('support') ? 'unsupported' : (assessed.support ? 'supported' : 'unknown'),
      ready: Boolean(model) && !hasErrors(diagnostics)
    };
    for (const requirement of coverage.requirements) requirement.status = requirement.relationIds.some(id => coverage.relations.some(r => r.id === id && r.status === 'compiled')) ? 'partial' : 'unbound';
    const inputReceipt = model ? layoutInputModel(model) : {};
    const receipt = {
      ...inputReceipt, schemaVersion: 1, kind: 'pcb-layout-input-receipt', units: 'mil', coordinateSystem: 'cartesian-y-up',
      preparation: { state, source, scope, coverage, diagnostics, nativeChecks: { ...nativeObservations(snapshot), network: nativeNetwork }, mutation: 'none', currentPlacementPreserved: true, objectScopeChecked: assessed.identity, logicalPinNetsChecked: Boolean(model), identityScope: 'PCB membership, object ownership, supplied footprint identity and logical-to-physical pin nets; not manufacturer-part verification' },
      review: { ...inputReceipt.review, actualRoutingEvaluation: 'not-implemented', roleTemplateCompilation: 'explicit-pin-relations-only', requirementCoverage: 'partial-or-unbound;never-full-electrical-approval' }
    };
    return { ...(model ? { model } : {}), contract, config, mechanical, receipt, diagnostics, coverage, state };
  };
  for (const [name, value] of Object.entries({ snapshot, contract, config, mechanical })) if (!object(value)) issue('structure', 'MISSING_INPUT_OBJECT', name, `${name} must be an object.`);
  if (hasErrors(diagnostics)) return finish();
  for (const [name, value, fields] of [['snapshot', snapshot, ['components', 'pads', 'items']], ['contract', contract, ['components', 'blocks', 'nets', 'constraints']], ['config', config, ['groups']]]) {
    for (const field of fields) if (!Array.isArray(value[field])) issue('structure', 'MISSING_INPUT_ARRAY', `${name}.${field}`, 'An explicit array is required, including when empty.');
  }
  if (!object(config.hard) || !object(config.search) || !object(config.connectivity) || !object(config.comparisonWeights)) issue('structure', 'MISSING_LAYOUT_CONFIGURATION', 'config', 'hard, search, connectivity and comparisonWeights are required objects.');
  if (!Number.isFinite(mechanical.clearanceMil) || mechanical.clearanceMil < 0) issue('structure', 'INVALID_CLEARANCE', 'mechanical.clearanceMil', 'A nonnegative clearance in mil is required.');
  if (hasErrors(diagnostics)) return finish();
  try { realization = layoutRealization(snapshot, contract, config.provider, mechanical); source.provider = realization.provider; source.normalization = realization.provenance ?? null; }
  catch (error) { issue('support', 'PROVIDER_INPUT_UNSUPPORTED', 'snapshot.layout', error.message); return finish(); }

  // Validate logical identity before taking the PCB-only projection. Excluded
  // schematic symbols may share nets with placed parts and remain upstream.
  const records = new Map(), requirements = new Map(), logicalNets = new Map();
  for (const [index, c] of contract.components.entries()) {
    const path = `contract.components[${index}]`;
    if (!object(c) || !text(c.designator) || records.has(c.designator)) { issue('structure', 'INVALID_COMPONENT_IDENTITY', path, 'A unique designator is required.'); continue; }
    records.set(c.designator, c);
    if (typeof c.includeInPcb !== 'boolean') issue('structure', 'MISSING_PCB_SCOPE', path + '.includeInPcb', 'Declare whether this component belongs on the PCB.');
    else scope[c.includeInPcb ? 'included' : 'excluded'].push(c.designator);
    if (!Array.isArray(c.pins) || c.pins.some(p => !object(p) || !text(p.number)) || new Set(array(c.pins).map(p => p?.number)).size !== array(c.pins).length) issue('structure', 'INVALID_LOGICAL_PINS', path + '.pins', 'Logical pin numbers must be unique nonempty strings.');
  }
  for (const [index, r] of contract.constraints.entries()) {
    if (!object(r) || !text(r.id) || requirements.has(r.id) || !text(r.requirement)) { issue('structure', 'INVALID_REQUIREMENT', `contract.constraints[${index}]`, 'A unique requirement id and its text are required.'); continue; }
    requirements.set(r.id, r);
    coverage.requirements.push({ id: r.id, requirement: r.requirement, source: `contract.constraints[${index}]`, status: 'unbound', relationIds: [], implementationScope: 'Explicit placement relations only; upstream evidenceState is not a layout result.' });
  }
  const netNames = new Set();
  for (const [index, n] of contract.nets.entries()) {
    if (!object(n) || !text(n.name) || netNames.has(n.name) || !Array.isArray(n.endpoints)) { issue('structure', 'INVALID_NET', `contract.nets[${index}]`, 'A unique net name and endpoint array are required.'); continue; }
    netNames.add(n.name);
    for (const endpoint of n.endpoints) {
      const key = `${endpoint?.component}\0${endpoint?.pin}`, c = records.get(endpoint?.component);
      if (!c || !text(endpoint.pin) || !array(c.pins).some(p => p?.number === endpoint.pin)) issue('structure', 'UNKNOWN_NET_ENDPOINT', `contract.nets[${index}]`, `Unknown logical endpoint ${endpoint?.component}.${endpoint?.pin}.`);
      if (logicalNets.has(key)) issue('structure', 'DUPLICATE_NET_ENDPOINT', `contract.nets[${index}]`, `Endpoint ${endpoint?.component}.${endpoint?.pin} occurs more than once.`);
      logicalNets.set(key, n.name);
    }
  }
  const memberships = new Set(), blockIds = new Set();
  for (const [index, b] of contract.blocks.entries()) {
    if (!object(b) || !text(b.id) || blockIds.has(b.id) || !Array.isArray(b.components)) { issue('structure', 'INVALID_BLOCK', `contract.blocks[${index}]`, 'A unique block id and member array are required.'); continue; }
    blockIds.add(b.id);
    for (const ref of b.components) {
      if (!records.has(ref) || memberships.has(ref)) issue('structure', 'INVALID_BLOCK_MEMBERSHIP', `contract.blocks[${index}]`, `Unknown or repeated primary member ${ref}.`);
      memberships.add(ref);
    }
  }
  if (hasErrors(diagnostics)) return finish();

  const native = new Map(), ids = new Set(), nativeRefs = new Set();
  for (const [index, c] of snapshot.components.entries()) {
    const path = `snapshot.components[${index}]`;
    if (!object(c) || !text(c.ref) || !text(c.id) || native.has(c.ref) || ids.has(c.id)) { issue('identity', 'INVALID_NATIVE_COMPONENT', path, 'Native component refs and ids must be unique.'); continue; }
    native.set(c.ref, c); ids.add(c.id); nativeRefs.add(c.ref);
    if (![c.x, c.y, c.rotation].every(Number.isFinite) || !boxValid(c.bbox ?? c.body)) issue('structure', 'INVALID_NATIVE_GEOMETRY', path, 'A finite pose and positive bounding box are required.');
    if (!records.has(c.ref)) scope.pcbOnly.push(c.ref);
    else if (!records.get(c.ref).includeInPcb) scope.excludedPresent.push(c.ref);
    const footprint = records.get(c.ref)?.footprint;
    if (footprint?.selection === 'exact' && text(footprint.name) && footprint.name !== c.footprint?.name) issue('identity', 'FOOTPRINT_IDENTITY_MISMATCH', path + '.footprint', `Expected exact footprint ${footprint.name}; observed ${c.footprint?.name ?? 'unknown'}.`);
    if (realization.layers[c.id] !== 'top-copper') issue('support', 'UNSUPPORTED_COMPONENT_LAYER', path + '.layer', 'The current solver requires an explicitly recorded top-layer component.');
    if (Number.isFinite(c.rotation) && Math.abs(c.rotation / 90 - Math.round(c.rotation / 90)) > 1e-8) issue('support', 'UNSUPPORTED_COMPONENT_ROTATION', path + '.rotation', 'The current solver supports quarter-turn source rotations.');
  }
  const standaloneRefs = new Set();
  for (const [index, p] of snapshot.pads.entries()) {
    const path = `snapshot.pads[${index}]`;
    if (!object(p) || !text(p.id) || ids.has(p.id) || !text(String(p.number ?? ''))) { issue('identity', 'INVALID_NATIVE_PAD', path, 'Native pad id and number are required and ids must be unique.'); continue; }
    ids.add(p.id);
    if (![p.x, p.y].every(Number.isFinite) || !boxValid(p.bbox)) issue('structure', 'INVALID_PAD_GEOMETRY', path, 'A finite pad position and positive bounding box are required.');
    let owner;
    try { owner = padOwner(p, native)?.ref ?? null; }
    catch (error) { issue('identity', error.message.split(' ')[0], path, error.message); continue; }
    if (snapshot.padOwnership?.status === 'verified' && (p.owner === undefined || p.parentComponentId === undefined)) issue('identity', 'INCOMPLETE_NATIVE_OWNERSHIP', path, 'Verified native ownership requires an explicit owner and parent ID for every pad.');
    if (!['top-copper', 'all-copper'].includes(realization.layers[p.id])) issue('support', 'UNSUPPORTED_PAD_LAYER', path + '.layer', 'Supported pads belong to top copper or all copper layers.');
    if (owner === null) {
      const ref = String(p.number), record = records.get(ref);
      if (nativeRefs.has(ref) || standaloneRefs.has(ref)) issue('identity', 'DUPLICATE_STANDALONE_REF', path, `Standalone pad ${ref} collides with another object identity.`);
      standaloneRefs.add(ref); scope.standalonePads.push(ref);
      if (!record) scope.pcbOnly.push(ref);
      else if (!record.includeInPcb) scope.excludedPresent.push(ref);
      else if (record.pins.length !== 1) issue('identity', 'INVALID_STANDALONE_COMPONENT', path, `Standalone pad ${ref} must correspond to exactly one logical pin.`);
    }
  }
  scope.missing = scope.included.filter(ref => !native.has(ref) && !standaloneRefs.has(ref));
  for (const [name, code] of [['missing', 'MISSING_PCB_OBJECT'], ['pcbOnly', 'PCB_ONLY_OBJECT'], ['excludedPresent', 'EXCLUDED_OBJECT_ON_PCB']]) for (const ref of scope[name]) issue('identity', code, 'scope.' + name, `Resolve PCB scope explicitly for ${ref}; no objects were added, removed or ignored.`);
  const designators = new Map();
  for (const [index, label] of snapshot.items.entries()) {
    const path = `snapshot.items[${index}]`;
    if (!object(label) || !text(label.id) || ids.has(label.id) || !native.has(label.owner)) { issue('identity', 'INVALID_LABEL_IDENTITY', path, 'Each label requires a unique id and an existing owner.'); continue; }
    ids.add(label.id);
    if (label.type === 'attribute') {
      if (label.parentId !== native.get(label.owner).id || label.text !== label.owner) issue('identity', 'DESIGNATOR_OWNER_MISMATCH', path, 'The designator value and parent must agree with its owner.');
      designators.set(label.owner, (designators.get(label.owner) ?? 0) + 1);
    } else if (label.type !== 'string') issue('support', 'UNSUPPORTED_LABEL_TYPE', path, 'Only native designators and explicitly owned strings are supported.');
    if (realization.layers[label.id] !== 'top-silkscreen') issue('support', 'UNSUPPORTED_LABEL_LAYER', path, 'The current solver requires top silkscreen labels.');
  }
  for (const ref of native.keys()) if (designators.get(ref) !== 1) issue('support', 'DESIGNATOR_COVERAGE', 'snapshot.items', `${ref} requires exactly one visible native designator; hidden or absent labels are not reconstructed.`);
  if (config.hard.boardBounds !== null) issue('support', 'UNSUPPORTED_BOARD_BOUNDS', 'config.hard.boardBounds', 'This solver requires an explicit null boardBounds; bounded-board search is not implemented.');
  if (mechanical.boardBounds != null) issue('support', 'UNSUPPORTED_MECHANICAL_BOARD_BOUNDS', 'mechanical.boardBounds', 'The mechanical and layout board scope must agree.');
  for (const key of ['traceCount', 'viaCount', 'pourCount', 'unmodeledObstacleCount']) if ((snapshot.support?.[key] ?? 0) > 0) issue('support', 'UNSUPPORTED_EXISTING_OBJECTS', `snapshot.support.${key}`, `${key} is outside the placement model.`);
  for (const [kind, count] of Object.entries(snapshot.routing ?? {})) if ((Array.isArray(count) ? count.length : count) > 0) issue('support', 'EXISTING_ROUTING_UNSUPPORTED', `snapshot.routing.${kind}`, 'Placement search cannot preserve existing routed copper.');
  if (array(snapshot.regions).length) issue('support', 'NATIVE_REGION_UNSUPPORTED', 'snapshot.regions', 'Native regions are not represented by this solver.');
  if (array(snapshot.outlines).length) issue('support', 'NATIVE_BOARD_OUTLINE_UNSUPPORTED', 'snapshot.outlines', 'A native board outline cannot be enforced by the current unbounded solver.');
  for (const unsupported of array(snapshot.capabilities?.unsupported)) issue('support', 'PROVIDER_UNSUPPORTED_OBJECT', 'snapshot.capabilities.unsupported', JSON.stringify(unsupported));
  assessed.identity = true; assessed.support = true;

  // Scope projection is explicit and reproducible; it does not alter upstream
  // artifacts or the current PCB, and never drops native-only objects silently.
  contract.components = contract.components.filter(c => c.includeInPcb);
  contract.blocks = contract.blocks.map(b => ({ ...b, components: b.components.filter(ref => records.get(ref).includeInPcb) })).filter(b => b.components.length);
  contract.nets = contract.nets.map(n => ({ ...n, endpoints: n.endpoints.filter(e => records.get(e.component).includeInPcb) })).filter(n => n.endpoints.length);
  compileIntent(contract.extensions?.pcbLayout, { config, records, requirements, logicalNets, native, issue, coverage, diagnostics });
  validateProfiles(config, issue);
  if (hasErrors(diagnostics)) return finish();
  try { model = compileModel(snapshot, contract, config, mechanical); }
  catch (error) {
    const identityFailure = /PIN_NET_MISMATCH|MISSING_PHYSICAL_PIN|UNKNOWN_ENDPOINT|INVALID_STANDALONE_ENDPOINT|CONFLICTING_PHYSICAL_NET/.test(error.message);
    issue(identityFailure ? 'identity' : 'compile', identityFailure ? 'MODEL_IDENTITY_FAILED' : 'MODEL_COMPILE_FAILED', '', error.message);
  }
  if (model) {
    nativeNetwork = auditNativeNetlist({ snapshot, contract, realization });
    for (const diagnostic of nativeNetwork.diagnostics ?? []) diagnostics.push({ ...diagnostic, category: diagnostic.severity === 'error' ? 'identity' : 'coverage', path: 'snapshot.nativeNetlist', severity: diagnostic.severity ?? 'warning' });
  }
  return finish();
}

function validateProfiles(config, issue) {
  const profiles = config.search.profiles, names = new Set();
  if (!Array.isArray(profiles) || !profiles.length) { issue('structure', 'MISSING_SEARCH_PROFILES', 'config.search.profiles', 'At least one effective search profile is required.'); return; }
  for (const [index, profile] of profiles.entries()) {
    const path = `config.search.profiles[${index}]`;
    if (!object(profile)) { issue('structure', 'INVALID_SEARCH_PROFILE', path, 'A search profile must be an object.'); continue; }
    if (!text(profile.name) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile.name) || names.has(profile.name)) issue('structure', 'INVALID_SEARCH_PROFILE_NAME', path + '.name', 'Profile names must be unique path-safe identifiers.');
    names.add(profile.name);
    if (!Number.isInteger(profile.seed) || profile.seed < 0 || profile.seed > 0xffffffff) issue('structure', 'INVALID_SEARCH_SEED', path + '.seed', 'Provide a reproducible unsigned 32-bit integer seed.');
    try {
      if (!object(profile.weights)) throw Error('Provide effective weights after configuration; multipliers alone are not executable.');
      validateWeights(profile.weights, config.groups);
    } catch (error) { issue('structure', 'INVALID_SEARCH_WEIGHTS', path + '.weights', error.message); }
  }
}

function compileIntent(intent, context) {
  const { config, records, requirements, logicalNets, native, issue, coverage } = context;
  const fields = (value, allowed, required, path) => {
    if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) { issue('semantic', 'INVALID_INTENT_FIELDS', path, 'Missing or unsupported intent fields.'); return false; }
    return true;
  };
  const groups = new Map();
  for (const [index, group] of config.groups.entries()) {
    if (!object(group) || !text(group.id) || groups.has(group.id) || !Array.isArray(group.links)) { issue('structure', 'INVALID_OBJECTIVE_GROUP', `config.groups[${index}]`, 'Objective groups require unique ids and link arrays.'); continue; }
    groups.set(group.id, group);
    const objectiveKeys = new Set();
    for (const [j, link] of group.links.entries()) {
      if (!object(link) || !text(link.a) || !text(link.b) || !Array.isArray(link.nets) || !link.nets.length || link.nets.some(n => !text(n))) issue('structure', 'INVALID_DISTANCE_OBJECTIVE', `config.groups[${index}].links[${j}]`, 'An objective requires two component refs and explicit net names.');
      else for (const net of link.nets) {
        const key = pairKey(link.a, link.aPin, link.b, link.bPin, net);
        if (objectiveKeys.has(key)) issue('structure', 'DUPLICATE_DISTANCE_OBJECTIVE', `config.groups[${index}].links[${j}]`, 'The same group must not count a pin-distance objective more than once.');
        objectiveKeys.add(key);
      }
      coverage.explicitRules.push({ source: `config.groups[${index}].links[${j}]`, group: group.id, basis: link?.basis ?? null, requirementBinding: 'none', scope: 'pin-distance-objective' });
    }
  }
  if (config.hard.pinDistanceLimits !== undefined && (!Array.isArray(config.hard.pinDistanceLimits) || config.hard.pinDistanceLimits.some(l => !object(l) || !text(l.a) || !text(l.b) || !text(l.net) || !Number.isFinite(l.maxMil) || l.maxMil < 0))) issue('structure', 'INVALID_DISTANCE_LIMITS', 'config.hard.pinDistanceLimits', 'Limits require two refs, a net and a finite nonnegative maxMil.');
  if (hasErrors(context.diagnostics)) return;
  if (intent === undefined) return;
  if (!fields(intent, ['schemaVersion', 'relations'], ['schemaVersion', 'relations'], 'contract.extensions.pcbLayout')) return;
  if (intent.schemaVersion !== 1 || !Array.isArray(intent.relations)) { issue('semantic', 'INVALID_INTENT_VERSION', 'contract.extensions.pcbLayout', 'Expected schemaVersion 1 and a relations array.'); return; }
  const ids = new Set(), pairs = new Set();
  for (const [index, relation] of intent.relations.entries()) {
    const source = `contract.extensions.pcbLayout.relations[${index}]`, errorsBefore = contextErrorCount();
    if (!fields(relation, ['id', 'kind', 'from', 'to', 'net', 'basis', 'requirementId', 'maxDistanceMil'], ['id', 'kind', 'from', 'to', 'net', 'basis'], source)) continue;
    const entry = { id: relation.id, source, kind: relation.kind, basis: relation.basis, requirementId: relation.requirementId ?? null, status: 'invalid', implements: [], exclusions: ['routed-copper', 'electrical-performance'] };
    coverage.relations.push(entry);
    if (!text(relation.id) || ids.has(relation.id)) issue('semantic', 'DUPLICATE_OR_INVALID_RELATION_ID', source + '.id', 'Relation ids must be unique nonempty strings.');
    ids.add(relation.id);
    if (!Object.hasOwn(relationGroup, relation.kind) || !text(relation.net) || !text(relation.basis)) issue('semantic', 'INVALID_RELATION', source, 'Use a supported kind, net and explicit basis.');
    if (relation.requirementId !== undefined) {
      if (!text(relation.requirementId) || !requirements.has(relation.requirementId)) issue('semantic', 'UNKNOWN_REQUIREMENT', source + '.requirementId', 'requirementId must reference an upstream constraint.');
      else coverage.requirements.find(r => r.id === relation.requirementId).relationIds.push(relation.id);
    }
    if (relation.maxDistanceMil !== undefined && (!Number.isFinite(relation.maxDistanceMil) || relation.maxDistanceMil < 0)) issue('semantic', 'INVALID_RELATION_DISTANCE', source + '.maxDistanceMil', 'Use an explicit finite nonnegative distance in mil.');
    for (const side of ['from', 'to']) {
      const endpoint = relation[side];
      if (!fields(endpoint, ['ref', 'pin'], ['ref', 'pin'], source + '.' + side)) continue;
      if (!text(endpoint.ref) || !text(endpoint.pin) || !records.get(endpoint.ref)?.includeInPcb || !array(records.get(endpoint.ref)?.pins).some(p => p?.number === endpoint.pin)) issue('semantic', 'UNKNOWN_RELATION_ENDPOINT', source + '.' + side, 'Endpoint must reference a placed logical component and pin.');
      else if (!native.has(endpoint.ref)) issue('support', 'STANDALONE_DISTANCE_OBJECTIVE_UNSUPPORTED', source + '.' + side, 'Pin-distance objectives currently require component-owned pads.');
      if (logicalNets.get(`${endpoint.ref}\0${endpoint.pin}`) !== relation.net) issue('semantic', 'RELATION_NET_MISMATCH', source + '.' + side, 'Both endpoints must belong to the declared net.');
    }
    if (contextErrorCount() !== errorsBefore) continue;
    const { from, to, net } = relation, groupId = relationGroup[relation.kind], key = pairKey(from.ref, from.pin, to.ref, to.pin, net);
    if (from.ref === to.ref) { issue('semantic', 'SAME_COMPONENT_RELATION', source, 'A placement relation must connect different components.'); continue; }
    if (pairs.has(groupId + key)) { issue('semantic', 'DUPLICATE_RELATION_OBJECTIVE', source, 'Duplicate distance objectives would double-count the same relation.'); continue; }
    pairs.add(groupId + key);
    let group = groups.get(groupId);
    if (!group) { group = { id: groupId, label: groupId, links: [] }; config.groups.push(group); groups.set(groupId, group); }
    const matching = group.links.filter(link => array(link?.nets).includes(net) && ((link.a === from.ref && link.b === to.ref) || (link.a === to.ref && link.b === from.ref)));
    const exact = matching.filter(link => pairKey(link.a, link.aPin, link.b, link.bPin, net) === key);
    const broad = matching.filter(link => {
      const same = link.a === from.ref, aPin = same ? from.pin : to.pin, bPin = same ? to.pin : from.pin;
      return (link.aPin === undefined || String(link.aPin) === aPin) && (link.bPin === undefined || String(link.bPin) === bPin) && (link.aPin === undefined || link.bPin === undefined);
    });
    if (exact.length > 1 || broad.length) { issue('semantic', 'OVERLAPPING_DISTANCE_OBJECTIVES', source, 'Resolve overlapping declared links explicitly before adding this pin-specific relation.'); continue; }
    const limits = config.hard.pinDistanceLimits ?? [];
    if (!Array.isArray(limits)) { issue('structure', 'INVALID_DISTANCE_LIMITS', 'config.hard.pinDistanceLimits', 'An array is required.'); continue; }
    const existingLimit = limits.filter(l => pairKey(l.a, l.aPin, l.b, l.bPin, l.net) === key);
    if (relation.maxDistanceMil !== undefined && existingLimit.some(l => l.maxMil !== relation.maxDistanceMil)) { issue('semantic', 'CONFLICTING_DISTANCE_LIMIT', source, 'The project limit and upstream relation disagree; no override was selected.'); continue; }
    if (!exact.length) group.links.push({ a: from.ref, aPin: from.pin, b: to.ref, bPin: to.pin, nets: [net], basis: relation.basis });
    if (relation.maxDistanceMil !== undefined && !existingLimit.length) config.hard.pinDistanceLimits = [...limits, { a: from.ref, aPin: from.pin, b: to.ref, bPin: to.pin, net, maxMil: relation.maxDistanceMil }];
    entry.status = 'compiled'; entry.group = groupId; entry.implements.push({ type: 'pin-distance-objective', group: groupId, net, from: { ...from }, to: { ...to }, weightSource: 'config.comparisonWeights', effectiveWeight: config.comparisonWeights[groupId] ?? 0, active: (config.comparisonWeights[groupId] ?? 0) > 0 });
    if (relation.maxDistanceMil !== undefined) entry.implements.push({ type: 'pin-distance-maximum', maxDistanceMil: relation.maxDistanceMil });
  }
  function contextErrorCount() { return context.diagnostics.filter(d => d.severity === 'error').length; }
}
