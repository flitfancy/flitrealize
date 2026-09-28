import { nativeObservations } from './pcb-layout-observations.mjs';
// A normalized receipt of authoritative inputs, not a second editable netlist.
export function layoutInputModel(model) {
  const { snapshot, contract, config, mechanical, couplingModel, realization } = model;
  const records = new Map(contract.components.map(c => [c.designator, c]));
  const blockByRef = new Map(contract.blocks.flatMap(b => b.components.map(ref => [ref, b.id])));
  const featureByRef = new Map((config.componentFeatures ?? []).map(f => [f.ref, f]));
  return {
    schemaVersion: 1, kind: 'pcb-layout-input-receipt', units: 'mil', coordinateSystem: 'cartesian-y-up', provider: realization.provider,
    source: { projectId: realization.target?.projectId ?? null, documentId: realization.target?.documentId ?? null, snapshotSourceHash: snapshot.sourceHash, authoritative: { contract: config.contractFile, features: config.featuresFile, spatial: config.spatialFile, geometry: config.geometryViewsFile, coupling: config.blockCouplingFile, spacingPolicy: config.spacingPolicyFile, assemblyRules: config.assemblyRulesFile, initialization: config.initializationFile }, editable: false },
    board: { bounds: config.hard.boardBounds, placementClearanceMil: mechanical.clearanceMil, explicitFixed: config.hard.fixed ?? [], weights: config.comparisonWeights, scoreReferences: model.scoreReferences, spatialDefaults: { uniformity: model.spacingPolicy ? null : config.spatial?.uniformity ?? null }, zones: config.spatial?.zones ?? [], spacingPolicy: model.spacingPolicy ?? null, assemblyPolicy: model.assemblyPolicy ?? null },
    blocks: contract.blocks.map(b => ({ id: b.id, purpose: b.purpose ?? '', members: [...b.components], ports: couplingModel.ports.filter(p => p.blockId === b.id).map(p => p.id), localGroups: model.spatialRules.localGroups.filter(g => g.refs.some(ref => b.components.includes(ref))).map(g => g.id), rigidRegion: false })),
    localGroups: model.spatialRules.localGroups,
    components: snapshot.components.map(c => {
      const intent = records.get(c.ref);
      return { id: c.id, ref: c.ref, blockId: blockByRef.get(c.ref) ?? null, identity: intent?.identity ?? null, roleDescription: intent?.role ?? '', roleStatus: 'descriptive-not-template-compiled', logicalPins: intent?.pins ?? [], pinMap: realization.pinMaps[c.ref] ?? {}, footprint: c.footprint, pose: { x: c.x, y: c.y, rotation: c.rotation, layer: realization.layers[c.id] ?? null }, mobility: { fixed: model.fixed.has(c.ref), allowedRotations: model.allowedRotations.get(c.ref) }, features: featureByRef.get(c.ref) ?? null };
    }),
    standalonePads: model.pads.filter(p => !p.owner).map(p => ({ id: p.id, ref: p.number, blockId: blockByRef.get(p.number) ?? null, roleDescription: records.get(p.number)?.role ?? '', net: p.net, x: p.x, y: p.y, bbox: p.bbox, layer: realization.layers[p.id] ?? null })),
    relationships: { ports: couplingModel.ports, crossBlockNets: couplingModel.crossBlockNets, declared: config.blockCoupling?.relations ?? [], electricalObjectives: config.groups, spatialRelations: model.spatialRules.relations, placementAnchors: model.blockRules },
    geometry: { representation: 'axis-aligned-bounds', views: ['footprint', 'pads', 'silkscreen', 'placement', ...(model.assemblyPolicy ? ['physical'] : []), 'assembly', 'operation'], envelopes: config.geometryViews?.envelopes ?? [], assemblyAndOperationCoverage: model.assemblyPolicy ? 'assembly-rule-derived-proxy;operation-explicit-only' : 'explicit-declarations-only' },
    search: config.search, initialization: config.initialization ?? null,
    nativeObservations: nativeObservations(snapshot),
    edgeVariables: [...(model.edgeDomains ?? [])].map(([ref, d]) => ({ ref, status: d.status, fixed: d.fixed, variables: ['side', 'alongMil', 'legalRotation'], normalCoordinate: 'derived-from-current-layout-envelope', states: d.states.map(s => ({ side: s.side, rotation: s.rotation })) })),
    review: { decisionOwner: 'user', newQualityScoringAdded: false, roleTemplateCompilation: 'not-implemented', actualRoutingEvaluation: 'not-implemented', unknownGeometryIsNotClearanceApproval: true },
  };
}
