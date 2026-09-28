// Summarize optional native evidence without passing full shapes into the solver.
export function nativeObservations(snapshot = {}) {
  const pads = Array.isArray(snapshot?.pads) ? snapshot.pads : [];
  const verified = snapshot?.padOwnership?.status === 'verified';
  const declared = pads.every(pad => pad?.owner !== undefined || pad?.parentComponentId !== undefined);
  const fields = {};
  for (const key of ['pad', 'hole', 'rotation', 'holeOffsetX', 'holeOffsetY', 'holeRotation', 'metallization']) {
    const counts = { ok: 0, unavailable: 0, error: 0, notRecorded: 0 };
    for (const p of pads) {
      const status = p?.nativeGeometry?.fields?.[key]?.status;
      counts[['ok','unavailable','error'].includes(status) ? status : 'notRecorded']++;
    }
    fields[key] = counts;
  }
  return {
    ownership: {
      status: !declared ? 'missing' : verified ? 'verified' : 'provided',
      source: !declared ? 'not-recorded' : verified ? snapshot.padOwnership.source : 'explicit-owner-or-parent',
      pads: pads.length,
      parentIdsRecorded: pads.filter(p => p?.parentComponentId !== undefined).length,
    },
    geometry: {
      padsWithObservations: pads.filter(p => p?.nativeGeometry).length,
      fields,
      use: 'source-observations-only; solver uses bounding boxes',
    },
  };
}
