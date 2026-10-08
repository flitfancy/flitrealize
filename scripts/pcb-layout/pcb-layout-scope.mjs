import { measure } from './pcb-layout-solver-core.mjs';

// A view of the prepared public model, never a second editable source model.
// Every backend uses this projection for subsets, optional labels and open space.
export function scopeLayoutModel(full, { refs = [...full.components.keys()], placementMode = 'board', includeLabels = true, includeStandalonePads = placementMode === 'board' && refs.length === full.components.size, gaugeRef, gaugePose, contextPlacements = [], releaseFixedRefs = [] } = {}) {
  if (!['board', 'open'].includes(placementMode) || typeof includeLabels !== 'boolean' || !Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(r => !full.components.has(r)) || gaugeRef !== undefined && !refs.includes(gaugeRef)) throw Error('INVALID_LAYOUT_MODEL_SCOPE');
  const open = placementMode === 'open';
  const selected = new Set(refs), include = value => selected.has(value.ref ?? value.owner ?? value.designator);
  const standaloneIds = new Set(includeStandalonePads ? full.pads.filter(p => !p.owner).map(p => p.id) : []);
  const includePad = value => include(value) || standaloneIds.has(value.id), placementRefs = new Set([...refs, ...full.pads.filter(p => standaloneIds.has(p.id)).map(p => p.number)]);
  const lockProvenance = new Map(full.lockProvenance instanceof Map ? [...full.lockProvenance].filter(([ref]) => selected.has(ref)).map(([ref, sources]) => [ref, Array.isArray(sources) ? [...sources] : ['legacy.unknown']]) : []);
  for (const ref of full.fixed.keys()) if (selected.has(ref) && !lockProvenance.has(ref)) lockProvenance.set(ref, ['legacy.unknown']);
  const nativeLocked = new Set(full.snapshot.components.filter(c => selected.has(c.ref) && c.locked).map(c => c.ref));
  for (const [ref, sources] of lockProvenance) if (sources.includes('snapshot.locked')) nativeLocked.add(ref);
  const mechanicalLocked = new Set([...lockProvenance].filter(([, sources]) => sources.includes('mechanical.lockedDesignators')).map(([ref]) => ref));
  const hardFixed = new Set((full.config.hard.fixed ?? []).map(p => p.ref));
  if (!Array.isArray(releaseFixedRefs) || new Set(releaseFixedRefs).size !== releaseFixedRefs.length || releaseFixedRefs.some(ref => !selected.has(ref) || !full.fixed.has(ref))) throw Error('INVALID_OPEN_FIXED_RELEASE');
  for (const ref of releaseFixedRefs) {
    if (nativeLocked.has(ref)) throw Error('OPEN_NATIVE_LOCK_RELEASE_FORBIDDEN ' + ref);
    if (mechanicalLocked.has(ref)) throw Error('OPEN_MECHANICAL_LOCK_RELEASE_FORBIDDEN ' + ref);
    if (!hardFixed.has(ref)) throw Error('OPEN_RELEASE_REQUIRES_EXPLICIT_HARD_FIXED ' + ref);
    const sources = lockProvenance.get(ref);
    if (!sources?.length || sources.some(source => source !== 'hard.fixed')) throw Error('OPEN_LOCK_PROVENANCE_UNKNOWN ' + ref);
  }
  const released = new Set(releaseFixedRefs);
  const fixed = new Map([...full.fixed].filter(([ref]) => selected.has(ref) && !released.has(ref)).map(([ref, pose]) => [ref, { ...pose }]));
  for (const ref of nativeLocked) if (!fixed.has(ref)) {
    const component = full.components.get(ref); fixed.set(ref, { ref, x: component.x, y: component.y, rotation: component.rotation });
  }
  const preservedFixedRefs = [...fixed.keys()];
  if (!Array.isArray(contextPlacements) || contextPlacements.some(p => !p || !selected.has(p.ref)) || new Set(contextPlacements.map(p => p.ref)).size !== contextPlacements.length) throw Error('INVALID_OPEN_CONTEXT');
  const samePose = (a, b) => ['x', 'y', 'rotation'].every(key => a[key] === b[key]);
  for (const p of contextPlacements) {
    const pose = { ref: p.ref, x: p.x, y: p.y, rotation: p.rotation }, original = fixed.get(p.ref);
    if (original && !samePose(pose, original)) throw Error('OPEN_CONTEXT_FIXED_POSE_CONFLICT ' + p.ref);
    fixed.set(p.ref, pose);
    lockProvenance.set(p.ref, [...new Set([...(lockProvenance.get(p.ref) ?? []), 'open.context'])]);
  }
  let gauge;
  if (gaugeRef !== undefined) {
    const rotation = full.allowedRotations.get(gaugeRef).includes(0) ? 0 : full.allowedRotations.get(gaugeRef)[0], retainedGauge = fixed.get(gaugeRef);
    gauge = { ref: gaugeRef, x: gaugePose?.x ?? retainedGauge?.x ?? 0, y: gaugePose?.y ?? retainedGauge?.y ?? 0, rotation: gaugePose?.rotation ?? retainedGauge?.rotation ?? rotation };
    if (retainedGauge && !samePose(gauge, retainedGauge)) throw Error('OPEN_GAUGE_FIXED_POSE_CONFLICT ' + gaugeRef);
    fixed.set(gaugeRef, gauge); lockProvenance.set(gaugeRef, [...new Set([...(lockProvenance.get(gaugeRef) ?? []), 'open.gauge'])]);
  }
  for (const p of fixed.values()) if (!['x', 'y', 'rotation'].every(k => Number.isFinite(p[k])) || !full.allowedRotations.get(p.ref).includes(p.rotation)) throw Error('INVALID_OPEN_FIXED_POSE ' + p.ref);
  const assembly = full.assemblyPolicy ? { ...full.assemblyPolicy, records: full.assemblyPolicy.records.filter(include), pads: full.assemblyPolicy.pads.filter(includePad), pairClearancesMil: (full.assemblyPolicy.pairClearancesMil ?? []).filter(p => placementRefs.has(p.a) && placementRefs.has(p.b)) } : null;
  const scopedRelations = (full.spatialRules.relations ?? []).filter(r => selected.has(r.a) && r.anchors.every(ref => selected.has(ref)));
  const model = { ...full,
    snapshot: { ...full.snapshot, components: full.snapshot.components.filter(include), pads: full.snapshot.pads.filter(includePad), items: includeLabels ? full.snapshot.items.filter(include) : [], outlines: open ? [] : full.snapshot.outlines, regions: open ? [] : full.snapshot.regions },
    contract: { ...full.contract, components: full.contract.components.filter(component => placementRefs.has(component.designator)), blocks: full.contract.blocks.map(b => ({ ...b, components: b.components.filter(r => placementRefs.has(r)) })).filter(b => b.components.length), nets: full.contract.nets.map(n => ({ ...n, endpoints: n.endpoints.filter(e => placementRefs.has(e.component)) })).filter(n => n.endpoints.length) },
    config: { ...full.config, hard: { ...full.config.hard, boardBounds: open ? null : full.config.hard.boardBounds, fixed: [...fixed.values()] } },
    mechanical: { ...full.mechanical, boardBounds: open ? null : full.mechanical.boardBounds, lockedDesignators: [...fixed.keys()], ...(assembly ? { assemblyPolicy: assembly } : {}) },
    components: new Map([...full.components].filter(([ref]) => selected.has(ref))), pads: full.pads.filter(includePad), fixed, lockProvenance,
    allowedRotations: new Map([...full.allowedRotations].filter(([ref]) => selected.has(ref))), edgeRules: open ? [] : full.edgeRules.filter(include), edgeDomains: open ? new Map() : new Map([...full.edgeDomains].filter(([ref]) => selected.has(ref))),
    blockRules: full.blockRules.filter(r => selected.has(r.ref) && r.anchors.every(a => selected.has(a))),
    links: full.links.filter(l => [...l.left, ...l.right].every(p => selected.has(p.owner))),
    limits: full.limits.filter(l => [...l.left, ...l.right].every(p => selected.has(p.owner))),
    connectivity: full.connectivity.map(n => ({ ...n, pads: n.pads.filter(includePad) })).filter(n => new Set(n.pads.map(p => p.ref)).size > 1),
    geometryModel: { ...full.geometryModel, components: full.geometryModel.components.filter(include), pads: full.geometryModel.pads.filter(includePad), labels: includeLabels ? full.geometryModel.labels.filter(include) : [], envelopes: full.geometryModel.envelopes.filter(include), assemblyPolicy: assembly },
    spatialRules: { ...full.spatialRules, relations: scopedRelations, zones: full.spatialRules.zones.filter(z => (z.owner ? selected.has(z.owner) : !open) && (!z.targetRefs || z.targetRefs.some(r => selected.has(r)))).map(z => ({ ...z, excludeRefs: z.excludeRefs.filter(r => selected.has(r)), ...(z.targetRefs ? { targetRefs: z.targetRefs.filter(r => selected.has(r)) } : {}) })), localGroups: full.spatialRules.localGroups.map(g => ({ ...g, refs: g.refs.filter(r => selected.has(r)) })).filter(g => g.refs.length > 1) },
    couplingModel: { ...full.couplingModel, blocks: full.couplingModel.blocks.map(b => ({ ...b, components: b.components.filter(r => placementRefs.has(r)) })).filter(b => b.components.length), pads: full.couplingModel.pads.filter(includePad), relations: full.couplingModel.relations.filter(r => [r.from, r.to].every(e => selected.has(e.ref))), ports: full.couplingModel.ports.filter(p => p.endpoints.every(e => placementRefs.has(e.ref))), crossBlockNets: full.couplingModel.crossBlockNets.filter(n => n.endpoints.every(e => placementRefs.has(e.ref))), unassignedRefs: full.couplingModel.unassignedRefs.filter(r => placementRefs.has(r)) },
    assemblyPolicy: assembly,
    spacingPolicy: full.spacingPolicy ? { ...full.spacingPolicy, refs: full.spacingPolicy.refs.filter(r => placementRefs.has(r)), requirements: full.spacingPolicy.requirements.filter(r => r.refs.every(ref => placementRefs.has(ref))) } : null,
    referenceGeometry: new Map([...full.referenceGeometry].filter(([ref]) => placementRefs.has(ref))), pairClearanceMap: new Map([...full.pairClearanceMap].filter(([key]) => JSON.parse(key).every(r => placementRefs.has(r)))),
    modelScope: { schemaVersion: 1, kind: 'pcb-layout-model-scope', units: 'mil', sourceHash: full.snapshot.sourceHash, source: 'prepared public layout model', refs: [...refs], placementMode, includeLabels, includeStandalonePads,
      originalComponentCount: full.modelScope?.originalComponentCount ?? full.components.size, wholeBoard: refs.length === (full.modelScope?.originalComponentCount ?? full.components.size),
      boardBoundaryReleased: open && Boolean(full.config.hard.boardBounds), releasedEdgeRefs: open ? full.edgeRules.filter(r => selected.has(r.ref)).map(r => r.ref) : [],
      preservedFixedRefs, releasedFixedRefs: [...releaseFixedRefs], nativeLockedRefs: [...nativeLocked], mechanicalLockedRefs: [...mechanicalLocked], gaugePose: gauge,
      fixedPosePolicy: 'retain selected source poses; only explicit hard.fixed-only releases with known provenance; native and mechanical locks cannot be released', rotationDomains: 'retain compiled source domains' } };
  model.board = { ...full.board, bounds: model.config.hard.boardBounds, sources: open ? [] : full.board.sources };
  model.baselineMetrics = measure(model, model.snapshot.components);
  return model;
}
