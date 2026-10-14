// Included in each native request. Coordinates are native mil; no UI-unit conversion.
async function layoutNative(eda, input) {
  const { config: cfg, plan, snapshot: before } = input;
  let writeBaseline = input.writeBaseline ?? before;
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  const get = (o, k, fallback = null) => typeof o?.['getState_' + k] === 'function' ? o['getState_' + k]() : fallback;
  const angle = n => ((n % 360) + 360) % 360;
  const fail = message => { throw Error(message); };
  const finiteBox = b => b && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) && b.minX <= b.maxX && b.minY <= b.maxY;
  const sameBox = (a, b, eps = .01) => finiteBox(a) && finiteBox(b) && ['minX', 'minY', 'maxX', 'maxY'].every(k => Math.abs(a[k] - b[k]) <= eps);
  const box = async id => { const b = await eda.pcb_Primitive.getPrimitivesBBox([id]); if (!finiteBox(b)) fail('NATIVE_GEOMETRY_MISSING ' + id); return b; };
  const union = bs => bs.length ? { minX: Math.min(...bs.map(b => b.minX)), minY: Math.min(...bs.map(b => b.minY)), maxX: Math.max(...bs.map(b => b.maxX)), maxY: Math.max(...bs.map(b => b.maxY)) } : null;
  const sourceHash = source => { let h = 2166136261; for (const ch of source.split('\n').filter(l => !l.startsWith('{"type":"DOCHEAD"')).join('\n')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
  const errorText = error => error?.message ?? String(error);
  const jsonValue = value => {
    const seen = new Set();
    function check(v) {
      if (v === null || ['string', 'boolean'].includes(typeof v)) return;
      if (typeof v === 'number' && Number.isFinite(v)) return;
      if (typeof v !== 'object' || seen.has(v)) fail('NON_JSON_NATIVE_VALUE');
      seen.add(v); for (const entry of Array.isArray(v) ? v : Object.values(v)) check(entry); seen.delete(v);
    }
    check(value); return JSON.parse(JSON.stringify(value));
  };
  function observedField(primitive, getter) {
    if (typeof primitive?.['getState_' + getter] !== 'function') return { status: 'unavailable' };
    try { return { status: 'ok', value: jsonValue(primitive['getState_' + getter]()) }; }
    catch (error) { return { status: 'error', error: errorText(error) }; }
  }
  async function optionalRead(object, method, source, key, validate) {
    if (typeof object?.[method] !== 'function') return { status: 'unavailable', source };
    try { const value = await object[method](); if (!validate(value)) fail('INVALID_NATIVE_RESULT ' + source); return { status: 'ok', source, [key]: jsonValue(value) }; }
    catch (error) { return { status: 'error', source, error: errorText(error) }; }
  }
  function padComponent(pad, components) {
    if (pad.owner === null && pad.parentComponentId === null) return null;
    if (typeof pad.owner !== 'string' || typeof pad.parentComponentId !== 'string') fail('PAD_OWNERSHIP_BASELINE_MISSING ' + pad.id);
    const component = components.find(c => c.ref === pad.owner && c.id === pad.parentComponentId);
    if (!component) fail('PAD_PARENT_IDENTITY_MISMATCH ' + pad.id);
    return component;
  }
  async function target() {
    if (!cfg?.expectedProjectUuid || !cfg?.expectedDocumentUuid) fail('TARGET_REQUIRED');
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    if (d?.uuid !== cfg.expectedDocumentUuid || d?.parentProjectUuid !== cfg.expectedProjectUuid || d.documentType !== 3) fail('TARGET_MISMATCH');
    return d;
  }
  async function read() {
    const document = await target(), source = await eda.sys_FileManager.getDocumentSource();
    const components = [], pads = [], items = [], unsupported = [], rawComponents = await eda.pcb_PrimitiveComponent.getAll();
    for (const c of rawComponents) {
      const id = get(c, 'PrimitiveId');
      components.push({ id, ref: get(c, 'Designator'), x: get(c, 'X'), y: get(c, 'Y'), rotation: get(c, 'Rotation'), layer: get(c, 'Layer'), locked: get(c, 'PrimitiveLock'), footprint: get(c, 'Footprint'), bbox: await box(id) });
      if (get(c, 'Layer') !== 1) unsupported.push({ code: 'COMPONENT_LAYER_UNSUPPORTED', id, layer: get(c, 'Layer') });
    }
    if (new Set(components.map(c => c.id)).size !== components.length || new Set(components.map(c => c.ref)).size !== components.length) fail('DUPLICATE_COMPONENT_IDENTITY');
    const flatPads = await eda.pcb_PrimitivePad.getAll(), flatById = new Map();
    for (const p of flatPads) {
      const id = get(p, 'PrimitiveId');
      if (typeof id !== 'string' || !id || flatById.has(id)) fail('DUPLICATE_OR_INVALID_PAD_ID ' + id);
      flatById.set(id, p);
    }
    const ownership = new Map(), ownershipMethods = { instance: 0, class: 0 };
    // Every component query must finish and agree with the independent global
    // pad inventory before an unclaimed pad can be called standalone.
    for (let start = 0; start < rawComponents.length; start += 8) {
      const batch = rawComponents.slice(start, start + 8);
      const claims = await Promise.all(batch.map(async c => {
        const id = get(c, 'PrimitiveId'), ref = get(c, 'Designator'); let pins, method;
        try {
          if (typeof c.getAllPins === 'function') { method = 'instance'; pins = await c.getAllPins(); }
          else if (typeof eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId === 'function') { method = 'class'; pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id); }
          else fail('PAD_OWNERSHIP_API_UNAVAILABLE ' + ref);
        } catch (error) { fail('PAD_OWNERSHIP_QUERY_FAILED ' + ref + ': ' + errorText(error)); }
        if (!Array.isArray(pins)) fail('PAD_OWNERSHIP_QUERY_INVALID ' + ref);
        // This optional local index is only a count/completeness check. Its
        // local primitiveId values are never interpreted as global pad IDs.
        if (typeof c.getState_Pads === 'function') {
          const index = c.getState_Pads();
          if (!Array.isArray(index) || index.length !== pins.length) fail('PAD_OWNERSHIP_QUERY_INCOMPLETE ' + ref);
        }
        return { id, ref, pins, method };
      }));
      for (const { id, ref, pins, method } of claims) {
        ownershipMethods[method]++;
        for (const p of pins) {
          const padId = get(p, 'PrimitiveId'), parentId = get(p, 'ParentComponentPrimitiveId'), native = flatById.get(padId);
          if (parentId !== id) fail('PAD_PARENT_IDENTITY_MISMATCH ' + ref + '/' + padId);
          if (ownership.has(padId)) fail('DUPLICATE_PAD_OWNER ' + padId);
          if (!native || String(get(native, 'PadNumber')) !== String(get(p, 'PadNumber')) || get(native, 'Net') !== get(p, 'Net')) fail('PAD_OWNERSHIP_FLAT_MISMATCH ' + ref + '/' + padId);
          ownership.set(padId, { owner: ref, parentComponentId: id });
        }
      }
    }
    for (const p of flatPads) {
      const id = get(p, 'PrimitiveId');
      const claim = ownership.get(id) ?? { owner: null, parentComponentId: null };
      if (typeof p.getState_ParentComponentPrimitiveId === 'function') {
        const parent = p.getState_ParentComponentPrimitiveId();
        if (parent !== undefined && parent !== claim.parentComponentId) fail('PAD_OWNERSHIP_FLAT_PARENT_MISMATCH ' + id);
      }
      const x = get(p, 'X'), y = get(p, 'Y'), fields = {};
      for (const key of ['Pad', 'Hole', 'Rotation', 'HoleOffsetX', 'HoleOffsetY', 'HoleRotation', 'Metallization']) fields[key[0].toLowerCase() + key.slice(1)] = observedField(p, key);
      pads.push({ id, ...claim, ownershipSource: 'native-component-pins', x, y, layer: get(p, 'Layer'), locked: get(p, 'PrimitiveLock'), net: get(p, 'Net'), number: get(p, 'PadNumber'), bbox: await box(id), nativeGeometry: { source: 'native-readback', coordinateSystem: 'eda-y-up', observedPose: { x, y, rotation: fields.rotation.status === 'ok' ? fields.rotation.value : null }, fields } });
      if (![1, 12].includes(get(p, 'Layer'))) unsupported.push({ code: 'PAD_LAYER_UNSUPPORTED', id, layer: get(p, 'Layer') });
    }
    async function label(a, type, c, text) {
      const id = get(a, 'PrimitiveId'), b = await box(id), r = get(a, 'Rotation'), vertical = angle(r) % 180 === 90;
      return { id, type, owner: c.ref, parentId: type === 'attribute' ? c.id : null, text, layer: get(a, 'Layer'), locked: get(a, 'PrimitiveLock'), width: vertical ? b.maxY - b.minY : b.maxX - b.minX, height: vertical ? b.maxX - b.minX : b.maxY - b.minY, fontSize: get(a, 'FontSize'), lineWidth: get(a, 'LineWidth'), original: { x: get(a, 'X'), y: get(a, 'Y'), rotation: r, alignMode: get(a, 'AlignMode'), bbox: b } };
    }
    for (const a of await eda.pcb_PrimitiveAttribute.getAll()) {
      if (get(a, 'Key') !== 'Designator' || !get(a, 'ValueVisible')) continue;
      const c = components.find(c => c.id === get(a, 'ParentPrimitiveId'));
      if (!c) fail('UNBOUND_DESIGNATOR');
      if (get(a, 'Layer') !== 3) unsupported.push({ code: 'DESIGNATOR_LAYER_UNSUPPORTED', id: get(a, 'PrimitiveId'), layer: get(a, 'Layer') });
      items.push(await label(a, 'attribute', c, get(a, 'Value')));
    }
    for (const c of components) if (items.filter(i => i.type === 'attribute' && i.owner === c.ref).length !== 1) unsupported.push({ code: 'VISIBLE_DESIGNATOR_COUNT', ref: c.ref });
    const rawStrings = await eda.pcb_PrimitiveString.getAll();
    if (cfg.includeFunctionalLabels !== false) for (const a of rawStrings) {
      const ref = cfg.functionalOwners?.[get(a, 'Text')], c = components.find(c => c.ref === ref);
      if (c && get(a, 'Layer') === 3) items.push(await label(a, 'string', c, get(a, 'Text')));
    }
    const routing = {}, outlines = [], regions = [], obstacles = [];
    for (const a of rawStrings) if (get(a, 'Layer') === 3 && !items.some(l => l.id === get(a, 'PrimitiveId'))) obstacles.push({ id: get(a, 'PrimitiveId'), kind: 'string', layer: 3, bbox: await box(get(a, 'PrimitiveId')) });
    for (const type of ['Line', 'Arc', 'Polyline', 'Via', 'Pour']) {
      const all = await eda['pcb_Primitive' + type].getAll();
      routing[type] = all.filter(a => ['Via', 'Pour'].includes(type) || [1, 2].includes(get(a, 'Layer')) || get(a, 'Layer') >= 15 && get(a, 'Layer') <= 44).length;
      if (['Line', 'Arc', 'Polyline'].includes(type)) for (const a of all.filter(a => get(a, 'Layer') === 3)) obstacles.push({ id: get(a, 'PrimitiveId'), kind: type, layer: 3, bbox: await box(get(a, 'PrimitiveId')) });
      if (type === 'Polyline') for (const a of all.filter(a => get(a, 'Layer') === 11)) outlines.push({ id: get(a, 'PrimitiveId'), path: get(a, 'Polygon')?.getSource?.() ?? null });
      if (['Line', 'Arc'].includes(type)) for (const a of all.filter(a => get(a, 'Layer') === 11)) outlines.push({ id: get(a, 'PrimitiveId'), kind: type });
    }
    if (eda.pcb_PrimitiveRegion?.getAll) for (const a of await eda.pcb_PrimitiveRegion.getAll()) regions.push({ id: get(a, 'PrimitiveId'), layer: get(a, 'Layer'), bbox: await box(get(a, 'PrimitiveId')) });
    const [nativeNetlist, nativeNetNames] = await Promise.all([
      optionalRead(eda.pcb_Net, 'getNetlist', 'pcb_Net.getNetlist', 'raw', value => typeof value === 'string' && value.length > 0),
      optionalRead(eda.pcb_Net, 'getAllNetsName', 'pcb_Net.getAllNetsName', 'value', value => Array.isArray(value) && value.every(v => typeof v === 'string')),
    ]);
    const padOwnership = { status: 'verified', source: 'native-component-pins', queriedComponents: components.length, ownedPads: ownership.size, standalonePads: pads.length - ownership.size, methods: ownershipMethods };
    if (sourceHash(await eda.sys_FileManager.getDocumentSource()) !== sourceHash(source)) fail('SOURCE_CHANGED_DURING_READ');
    return { status: 'inspected', units: 'mil', coordinateSystem: 'eda-y-up', sourceHash: sourceHash(source), source, document, components, pads, items, routing, outlines, regions, obstacles, padOwnership, nativeNetlist, nativeNetNames, capabilities: { units: 'mil', axes: 'native-y-up', componentLayers: [1], padLayers: [1, 12], labelLayers: [3], relativeRotationStep: 90, routedMovement: false, unsupported } };
  }
  function transform(p, old, next) {
    const q = angle(next.rotation - old.rotation) / 90;
    if (!Number.isInteger(q)) fail('UNSUPPORTED_ROTATION');
    const x = p.x - old.x, y = p.y - old.y, xy = [[x, y], [-y, x], [-x, -y], [y, -x]][q];
    return { x: next.x + xy[0], y: next.y + xy[1] };
  }
  function transformBox(b, old, next) {
    if (!finiteBox(b)) fail('PAD_BASELINE_GEOMETRY_MISSING');
    const ps = [[b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]].map(([x, y]) => transform({ x, y }, old, next));
    return { minX: Math.min(...ps.map(p => p.x)), minY: Math.min(...ps.map(p => p.y)), maxX: Math.max(...ps.map(p => p.x)), maxY: Math.max(...ps.map(p => p.y)) };
  }
  const moved = (a, b) => Math.abs(a.x - b.x) > .001 || Math.abs(a.y - b.y) > .001 || Math.abs(angle(a.rotation ?? 0) - angle(b.rotation ?? 0)) > 1e-7;
  function changes() {
    const components = plan.components.filter(c => moved(before.components.find(a => a.id === c.id), c)).map(c => c.id);
    const labels = plan.labels.filter(l => { const old = before.items.find(a => a.id === l.id); return before.components.some(c => c.ref === l.owner && components.includes(c.id)) || moved(old.original, l) || old.original.alignMode !== l.alignMode; }).map(l => l.id);
    const pads = before.pads.filter(p => components.includes(p.parentComponentId) || !p.owner && moved(p, plan.testPads.find(a => a.id === p.id))).map(p => p.id);
    return { components, labels, pads };
  }
  function dependencies(writeSet, live = writeBaseline) {
    // A pad may join or leave a relevant net after candidate creation. Compare
    // membership on both snapshots, rather than trusting only its old net.
    const pads = [...before.pads, ...live.pads];
    const nets = new Set(pads.filter(p => writeSet.pads.includes(p.id)).map(p => p.net).filter(Boolean));
    const refs = new Set([...(cfg.fineAcceptance?.dependencyRefs ?? []), ...(cfg.lockedDesignators ?? [])]);
    const padIds = new Set([...(cfg.fineAcceptance?.dependencyPadIds ?? []), ...pads.filter(p => nets.has(p.net) || refs.has(p.owner)).map(p => p.id)]);
    return { nets, refs, padIds };
  }
  function records(snapshot) {
    const rows = sourceRecords(snapshot.source).filter(r => !['DOCHEAD', 'CANVAS'].includes(r.type));
    const out = new Map(rows.map(r => [r.type + ':' + r.id, r]));
    if (out.size !== rows.length) fail('SOURCE_RECORD_IDENTITY');
    return out;
  }
  function sourceChanges(old, live, writeSet, dependency) {
    if (old.sourceHash === live.sourceHash) return [];
    let a, b;
    try { a = records(old); b = records(live); } catch (error) { fail('SOURCE_CHANGE_UNCLASSIFIED ' + error.message); }
    const affected = new Set([...writeSet.components, ...writeSet.labels, ...writeSet.pads, ...dependency.padIds, ...old.components.filter(c => dependency.refs.has(c.ref)).map(c => c.id)]);
    const observed = new Set([...old.components, ...live.components, ...old.pads, ...live.pads, ...old.items, ...live.items, ...(old.obstacles ?? []), ...(live.obstacles ?? [])].map(o => o.id));
    const preserved = [];
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const previous = a.get(key), current = b.get(key);
      if (equal(previous, current)) continue;
      const row = current ?? previous;
      if (affected.has(row.id)) fail('SOURCE_WRITE_DEPENDENCY_CHANGED ' + row.id);
      // Unobserved rule/stackup/constraint changes cannot be proved irrelevant.
      // Every changed geometry record must have a current or prior native bbox.
      if (!observed.has(row.id)) fail('SOURCE_CHANGE_UNCLASSIFIED ' + row.type + ':' + row.id);
      const object=[...live.components,...live.items,...live.pads,...old.components,...old.items,...old.pads].find(o=>o.id===row.id);
      preserved.push({ type: row.type, id: row.id, ref:object?.ref??object?.owner??object?.number??null,change:!previous?'added':!current?'removed':'modified',fields: [...new Set([...Object.keys(previous?.value ?? {}), ...Object.keys(current?.value ?? {})])].filter(k => !equal(previous?.value[k], current?.value[k])) });
    }
    return preserved;
  }
  function effectivePlan(baseline, writeSet) {
    const components = baseline.components.map(c => { const next = writeSet.components.includes(c.id) ? plan.components.find(a => a.id === c.id) : c; return { ...next, dx:next.x-c.x,dy:next.y-c.y,deltaRotation:angle(next.rotation-c.rotation),body: transformBox(c.bbox, c, next) }; });
    const labels = baseline.items.map(l => writeSet.labels.includes(l.id) ? plan.labels.find(a => a.id === l.id) : { ...l, ...l.original });
    const testPads = baseline.pads.filter(p => !padComponent(p, baseline.components)).map(p => writeSet.pads.includes(p.id) ? plan.testPads.find(a => a.id === p.id) : p);
    const pads = baseline.pads.map(p => { const c = padComponent(p, baseline.components), old = c ?? { ...p, rotation: 0 }, next = c ? components.find(a => a.id === c.id) : { ...testPads.find(a => a.id === p.id), rotation: 0 }; return { ...p, ...transform(p, old, next), bbox: transformBox(p.bbox, old, next) }; });
    return { ...plan, components, labels, testPads, pads, bundles: components.map(c => ({ ref: c.ref, bbox: union([c.body, ...(cfg.labelGeometryMode === 'separate' ? [] : labels.filter(l => l.owner === c.ref).map(l => l.bbox))]) })).concat(testPads.map(p => ({ ref: p.number, bbox: p.bbox }))) };
  }
  function checkPlan(live) {
    if (!plan || !before || !Array.isArray(plan.issues) || plan.issues.length) fail('PLAN_INVALID');
    if(!['joint','separate'].includes(cfg.labelGeometryMode??'joint')||(plan.geometryPolicy?.labelMode??'joint')!==(cfg.labelGeometryMode??'joint'))fail('PLAN_LABEL_GEOMETRY_POLICY');
    if (plan.sourceHash !== before.sourceHash) fail('SOURCE_CHANGED_REPLAN');
    if (live.capabilities.unsupported.length) fail('NATIVE_CAPABILITY_UNSUPPORTED ' + JSON.stringify(live.capabilities.unsupported));
    const boardBounds = resolveBoardBounds(decodeBoard(live.outlines), cfg.boardBounds).bounds;
    if (boardBounds ? !sameBox(boardBounds,plan.boardBounds,.001) : plan.boardBounds != null) fail('PLAN_BOARD_BOUNDS_MISMATCH');
    if (JSON.stringify(live.outlines) !== JSON.stringify(before.outlines)) fail('BOARD_OUTLINE_CHANGED');
    for (const [name, wanted] of [['components', before.components], ['labels', before.items], ['testPads', before.pads.filter(p => !padComponent(p, before.components))]]) {
      if (!Array.isArray(plan[name]) || plan[name].length !== wanted.length || new Set(plan[name].map(o => o.id)).size !== wanted.length || plan[name].some(o => !wanted.some(a => a.id === o.id))) fail('PLAN_OBJECT_IDS ' + name);
    }
    const writeSet = changes(), dependency = dependencies(writeSet, live);
    for (const key of ['components', 'items', 'pads']) if (live[key].length !== before[key].length || live[key].some(o => !before[key].some(a => a.id === o.id))) fail('LIVE_OBJECT_IDS ' + key);
    for (const c of plan.components) {
      const old = before.components.find(a => a.id === c.id), actual = live.components.find(a => a.id === c.id);
      if (!actual || c.ref !== old.ref || actual.ref !== old.ref || ![c.x, c.y, c.rotation].every(Number.isFinite)) fail('PLAN_COMPONENT_IDENTITY');
      if ((writeSet.components.includes(c.id) || dependency.refs.has(c.ref)) && !equal(old, actual)) fail('SOURCE_WRITE_DEPENDENCY_CHANGED ' + c.id);
      if ((actual.locked || cfg.lockedDesignators?.includes(c.ref)) && moved(old, c)) fail('LOCKED_COMPONENT ' + c.ref);
      if (moved(old, c) && live.pads.some(p => p.owner === c.ref && p.locked)) fail('LOCKED_COMPONENT_PAD ' + c.ref);
      transform({ x: old.x, y: old.y }, old, c);
      if (c.layer != null && c.layer !== actual.layer) fail('LAYER_CHANGE_UNSUPPORTED');
    }
    for (const l of plan.labels) {
      const old = before.items.find(a => a.id === l.id), actual = live.items.find(a => a.id === l.id);
      if (!actual || l.type !== old.type || l.owner !== old.owner || l.parentId !== old.parentId || l.text !== old.text || ![l.x, l.y, l.rotation].every(Number.isFinite) || !finiteBox(l.bbox) || actual.parentId !== old.parentId || actual.owner !== old.owner) fail('PLAN_LABEL_IDENTITY');
      if (writeSet.labels.includes(l.id) && !equal(actual, old)) fail('SOURCE_WRITE_DEPENDENCY_CHANGED ' + l.id);
      if (actual.locked && (moved(old.original, l) || old.original.alignMode !== l.alignMode)) fail('LOCKED_LABEL ' + l.id);
      if(cfg.labelGeometryMode==='separate'&&(l.fontSize!==old.fontSize||l.lineWidth!==old.lineWidth))fail('PLAN_LABEL_FORMAT_CHANGED '+l.id);
    }
    if (live.pads.length !== before.pads.length) fail('PAD_BASELINE_COUNT');
    for (const p of before.pads) { const actual = live.pads.find(a => a.id === p.id); if (!actual || actual.owner !== p.owner || actual.parentComponentId !== p.parentComponentId) fail('PAD_OWNER_CHANGED ' + p.id); if ((writeSet.pads.includes(p.id) || dependency.padIds.has(p.id)) && !equal(actual, p)) fail('PAD_BASELINE_CHANGED ' + p.id); }
    for (const p of plan.testPads) { const old = before.pads.find(a => a.id === p.id), actual = live.pads.find(a => a.id === p.id); if (!actual || ![p.x, p.y].every(Number.isFinite) || p.number !== old.number || p.net !== old.net) fail('PLAN_TESTPAD_IDENTITY'); if (actual.locked && moved(old, p)) fail('LOCKED_TESTPAD ' + p.id); }
    const hasMoves = plan.components.some(c => moved(before.components.find(a => a.id === c.id), c)) || plan.testPads.some(p => moved(before.pads.find(a => a.id === p.id), p));
    if (hasMoves && Object.values(live.routing).some(n => n)) fail('ROUTED_BOARD_MOVE_UNSUPPORTED');
    if (hasMoves && live.regions.length) fail('REGION_MOVEMENT_UNSUPPORTED');
    const preservedChanges = sourceChanges(before, live, writeSet, dependency);
    writeBaseline = live;
    const effective = effectivePlan(live, writeSet), { components: placements, labels, pads } = effective;
    const proposed = geometry(placements, labels, pads, boardBounds);
    proposed.issues.push(...obstacleIssues(live.obstacles, placements, labels, pads, writeSet));
    const qualified=qualifyGeometry(proposed,placements,labels,pads,boardBounds);
    if (qualified.issues.length) fail('PLAN_GEOMETRY_ISSUES ' + JSON.stringify(qualified.issues));
    return { ...qualified, effectivePlan: effective, writeSet, preservedChanges };
  }
  function qualifyGeometry(checked,components,labels,pads,boardBounds) {
    const policy=cfg.fineAcceptance;
    if(!policy)return {...checked,retainedOutsideIssues:[],wholeBoardAccepted:!checked.issues.length};
    if(policy.schemaVersion!==1||!['require-clean','retain-outside-issues'].includes(policy.baselinePolicy)||policy.sourceHash!==before.sourceHash||plan.sourceHash!==before.sourceHash)fail('FINE_BASELINE_BINDING_INVALID');
    const sourceComponents=writeBaseline.components.map(c=>({...c,body:c.bbox})),sourceLabels=writeBaseline.items.map(l=>({...l,...l.original}));
    const baseline=geometry(sourceComponents,sourceLabels,writeBaseline.pads,boardBounds);
    const partition=classifyFineIssues({issues:checked.issues,baselineIssues:baseline.issues,before:{components:sourceComponents,labels:sourceLabels,pads:writeBaseline.pads,boardBounds},after:{components,labels,pads,boardBounds},labelMode:cfg.labelGeometryMode??'joint',baselinePolicy:policy.liveScope ? 'retain-outside-issues' : policy.baselinePolicy});
    return {...checked,...partition,geometryIssues:checked.issues,issues:partition.blockingIssues,wholeBoardAccepted:!checked.issues.length};
  }
  function obstacleIssues(obstacles = [], placements, labels, pads, writeSet) {
    const gap=(a,b)=>Math.max(a.minX-b.maxX,b.minX-a.maxX,a.minY-b.maxY,b.minY-a.maxY),issues=[];
    const targets=[...placements.filter(c=>writeSet.components.includes(c.id)).map(c=>({id:c.id,bbox:c.body??c.bbox})),...labels.filter(l=>writeSet.labels.includes(l.id)),...pads.filter(p=>writeSet.pads.includes(p.id))];
    for(const obstacle of obstacles)for(const target of targets){const requiredMil=cfg.labelClearanceMil??cfg.clearanceMil??8,gapMil=gap(obstacle.bbox,target.bbox);if(gapMil<requiredMil-.001)issues.push({code:'LAYOUT_OBSTACLE_GAP',id:obstacle.id,targetId:target.id,gapMil,requiredMil});}
    return issues;
  }
  function geometry(placements, labels, pads, boardBounds = null) {
    if (cfg.assemblyPolicy && typeof assemblyRuntime !== 'function') fail('ASSEMBLY_RUNTIME_MISSING');
    const separate=cfg.labelGeometryMode==='separate';
    const testPads = pads.filter(p => !padComponent(p, placements));
    const bundles = placements.map(c => ({ ref: c.ref, bbox: union([c.body ?? c.bbox, ...(separate?pads.filter(p=>padComponent(p,placements)?.ref===c.ref).map(p=>p.bbox):labels.filter(l=>l.owner===c.ref).map(l=>l.bbox))]) })).concat(testPads.map(p => ({ ref: p.number, bbox: p.bbox })));
    const issues = []; let minimumAxisGapMil = Infinity;
    issues.push(...checkBoardBounds(boardBounds,[...placements.map(c=>({ref:c.ref,id:c.id,kind:'component',bbox:c.body??c.bbox})),...labels.map(l=>({...l,kind:'label'})),...pads.map(p=>({...p,kind:'pad'}))]));
    const pairs = new Map((cfg.pairClearancesMil ?? []).map(p => [JSON.stringify([p.a, p.b].sort()), p.hardMinMil]));
    for (let i = 0; i < bundles.length; i++) for (let j = i + 1; j < bundles.length; j++) {
      const a = bundles[i].bbox, b = bundles[j].bbox, gap = Math.max(a.minX - b.maxX, b.minX - a.maxX, a.minY - b.maxY, b.minY - a.maxY), requiredMil = separate?(pairs.get(JSON.stringify([bundles[i].ref,bundles[j].ref].sort()))??cfg.clearanceMil??8):Math.max(cfg.clearanceMil ?? 8, pairs.get(JSON.stringify([bundles[i].ref, bundles[j].ref].sort())) ?? 0);
      minimumAxisGapMil = Math.min(minimumAxisGapMil, gap);
      if (gap < requiredMil - .001) issues.push({ code: 'BUNDLE_CLEARANCE', refs: [bundles[i].ref, bundles[j].ref], gapMil: gap, requiredMil });
    }
    const assembly = cfg.assemblyPolicy ? assemblyRuntime(cfg.assemblyPolicy, placements, pads) : null;
    if (assembly) issues.push(...assembly.issues);
    if(separate){if(typeof independentLabelGeometry!=='function')fail('LABEL_GEOMETRY_RUNTIME_MISSING');issues.push(...independentLabelGeometry({components:placements,pads,labels,clearanceMil:cfg.labelClearanceMil??cfg.clearanceMil??8,gapByOwner:cfg.labelGapByOwner??{},maxOwnerDistanceMil:cfg.labelOwnerMaxDistanceMil}).issues);}
    return { issues, assembly, bundles, testPads, minimumAxisGapMil: Number.isFinite(minimumAxisGapMil) ? minimumAxisGapMil : null, extent: union([...bundles.map(b => b.bbox),...(separate?labels.map(l=>l.bbox):[])]) };
  }
  async function verify(expectedSourceHash) {
    const live = await read(), issues = [];
    if (expectedSourceHash != null && live.sourceHash !== expectedSourceHash) fail('SOURCE_CHANGED_RECONCILE');
    const writeSet = changes(), expected = effectivePlan(writeBaseline, writeSet);
    if (live.components.length !== writeBaseline.components.length || live.pads.length !== writeBaseline.pads.length || live.items.length !== writeBaseline.items.length) issues.push({ code: 'OBJECT_COUNT_CHANGED' });
    const placements = live.components.map(c => ({ ...c, body: c.bbox }));
    for (const c of expected.components) { const a = live.components.find(a => a.id === c.id), old = writeBaseline.components.find(b => b.id === c.id); if (!a || a.ref !== c.ref || moved(a, c) || a.layer !== old?.layer || a.locked !== old?.locked || !equal(a.footprint, old?.footprint) || !sameBox(a.bbox, c.body)) issues.push({ code: 'COMPONENT_READBACK_FAILED', ref: c.ref }); }
    const labels = [];
    for (const l of expected.labels) {
      const a = live.items.find(a => a.id === l.id), old = writeBaseline.items.find(a => a.id === l.id);
      if (!a || a.parentId !== l.parentId || a.text !== old.text || a.layer !== old.layer || !sameBox(a.original.bbox, l.bbox, .1) || moved(a.original, l) || a.original.alignMode !== l.alignMode) issues.push({ code: 'LABEL_READBACK_FAILED', id: l.id });
      if(cfg.labelGeometryMode==='separate'&&(a?.fontSize!==old.fontSize||a?.lineWidth!==old.lineWidth))issues.push({code:'LABEL_READBACK_FORMAT_CHANGED',id:l.id});
      if (a) labels.push({ ...l, ...a.original, layer: a.layer });
    }
    for (const p of writeBaseline.pads) {
      const a = live.pads.find(a => a.id === p.id), target = expected.pads.find(a => a.id === p.id);
      if (!a || a.owner !== p.owner || a.parentComponentId !== p.parentComponentId) issues.push({ code: 'PAD_OWNER_CHANGED', id: p.id });
      if (!a || a.net !== p.net || a.number !== p.number || a.layer !== p.layer || a.locked !== p.locked || !sameBox(a.bbox, target.bbox)) issues.push({ code: 'PAD_READBACK_FAILED', id: p.id });
    }
    let boardBounds = null;
    try {
      boardBounds = resolveBoardBounds(decodeBoard(live.outlines),cfg.boardBounds).bounds;
      if (boardBounds ? !sameBox(boardBounds,plan.boardBounds,.001) : plan.boardBounds != null) issues.push({code:'PLAN_BOARD_BOUNDS_MISMATCH'});
    } catch(error) { issues.push({code:error.code??'INVALID_BOARD_BOUNDS'}); }
    const proposed=geometry(placements, labels, live.pads,boardBounds);proposed.issues.push(...obstacleIssues(live.obstacles,placements,labels,live.pads,writeSet));
    const checked = qualifyGeometry(proposed,placements,labels,live.pads,boardBounds); issues.push(...checked.issues);
    for(const [key,code] of [['routing','ROUTING_CHANGED'],['regions','REGIONS_CHANGED'],['outlines','OUTLINES_CHANGED'],['obstacles','OBSTACLES_CHANGED']]) if (!equal(live[key] ?? [], writeBaseline[key] ?? [])) issues.push({ code });
    // The SDK getters do not expose every native field. Preserve all source
    // records outside the write set and all non-pose fields of written records.
    try {
      const a=records(writeBaseline),b=records(live),touched=new Set([...writeSet.components,...writeSet.labels,...writeSet.pads]);
      const metadata=value=>Object.fromEntries(Object.entries(value).filter(([k])=>!['x','y','rotation','alignmode','bbox'].includes(k.toLowerCase())));
      for(const key of new Set([...a.keys(),...b.keys()])){const old=a.get(key),now=b.get(key),id=(now??old).id;if(touched.has(id)?!old||!now||!equal(metadata(old.value),metadata(now.value)):!equal(old,now))issues.push({code:'SOURCE_READBACK_CHANGED',id});}
    } catch(error) { issues.push({code:'SOURCE_READBACK_UNCLASSIFIED',message:error.message}); }
    return { ...checked, wholeBoardAccepted:checked.wholeBoardAccepted&&!issues.length, status: issues.length ? 'verification-failed' : 'verified', saved: null, issues, source: live.source, sourceHash: live.sourceHash, document: live.document, placements, components: placements.length, labels, pads: live.pads, routing: live.routing, outlines: live.outlines, padOwnership: live.padOwnership, nativeNetlist: live.nativeNetlist, nativeNetNames: live.nativeNetNames, writeBaseline, writeSet, effectivePlan:expected, preservedChanges:sourceChanges(before,writeBaseline,writeSet,dependencies(writeSet)) };
  }
  return { get, read, target, sourceHash, checkPlan, moved, verify, fail, get writeBaseline() { return writeBaseline; } };
}
