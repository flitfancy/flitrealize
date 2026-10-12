/** Read-only compatibility boundary for old in-process routing journals.
 * Do not clear a journal or infer completion from age or a different target. */
export function probeRoutingCompatibility(globals, requestedTarget) {
  const sources = [
    ['__flitrealizeRoutingTransaction', 'flitrealize-routing', 'UNRESOLVED_ROUTING_TRANSACTION', false],
    ['__natureCraftSesImport', 'naturecraft-ses-import', 'OTHER_IMPORT_PENDING', true],
    ['__natureCraftAutorouteTask', 'naturecraft-autorouter', 'OTHER_ROUTER_PENDING', true],
    ['__flitrealizeBst2AutoRouteTrial', 'bst2-autoroute-trial', 'OTHER_ROUTER_PENDING', true],
  ];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const data = (value, key) => {
    if (!object(value)) return { reliable: false };
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return { reliable: !Reflect.has(value, key), value: undefined };
      return 'value' in descriptor ? { reliable: true, value: descriptor.value } : { reliable: false };
    } catch { return { reliable: false }; }
  };
  const identifier = value => typeof value === 'string' && value.trim().length > 0;
  const target = value => {
    if (!object(value)) return { status: 'unknown', value: null };
    const pairs = [['project', 'document'], ['projectUuid', 'pcbUuid'], ['expectedProjectUuid', 'expectedDocumentUuid']];
    const found = [];
    for (const [p, d] of pairs) {
      const project = data(value, p), document = data(value, d);
      if (!project.reliable || !document.reliable) return { status: 'unreliable', value: null };
      if (project.value === undefined && document.value === undefined) continue;
      if (!identifier(project.value) || !identifier(document.value)) return { status: 'unreliable', value: null };
      found.push({ project: project.value, document: document.value });
    }
    if (!found.length) return { status: 'unknown', value: null };
    if (found.some(v => v.project !== found[0].project || v.document !== found[0].document)) return { status: 'unreliable', value: null };
    return { status: 'known', value: found[0] };
  };
  const journalTarget = value => {
    const candidates = [target(value)];
    for (const field of ['target', 'before', 'after']) {
      const nested = data(value, field);
      if (!nested.reliable) return { status: 'unreliable', value: null };
      if (nested.value === undefined) continue;
      if (!object(nested.value)) return { status: 'unreliable', value: null };
      candidates.push(target(nested.value));
      if (field !== 'target') {
        const nestedTarget = data(nested.value, 'target');
        if (!nestedTarget.reliable) return { status: 'unreliable', value: null };
        if (nestedTarget.value !== undefined) candidates.push(target(nestedTarget.value));
      }
    }
    if (candidates.some(t => t.status === 'unreliable')) return { status: 'unreliable', value: null };
    const known = candidates.filter(t => t.status === 'known');
    if (!known.length) return { status: 'unknown', value: null };
    if (known.some(t => t.value.project !== known[0].value.project || t.value.document !== known[0].value.document)) return { status: 'unreliable', value: null };
    return known[0];
  };
  const request = target(requestedTarget), findings = [];
  if (request.status !== 'known') findings.push({ source: 'routing-request', key: null, legacy: false, present: true, status: 'unknown', saved: null, target: request, scope: 'unknown', state: 'blocked', code: 'ROUTING_COMPATIBILITY_UNKNOWN', reasons: ['requested-target-' + request.status] });
  for (const [key, source, code, legacy] of sources) {
    const observed = data(globals, key);
    if (observed.reliable && (observed.value === undefined || observed.value === null)) {
      findings.push({ source, key, legacy, present: false, status: 'absent', saved: null, target: { status: 'unknown', value: null }, scope: 'unknown', state: 'clear', code: null, reasons: ['journal-absent'] });
      continue;
    }
    const value = observed.value, status = data(value, 'status'), saved = data(value, 'saved');
    const scopeTarget = observed.reliable ? journalTarget(value) : { status: 'unreliable', value: null };
    const scope = request.status === 'known' && scopeTarget.status === 'known' ? (request.value.project === scopeTarget.value.project && request.value.document === scopeTarget.value.document ? 'same-target' : 'different-target') : 'unknown';
    const reasons = [];
    if (!observed.reliable || !object(value) || !status.reliable || !saved.reliable) reasons.push('journal-unreliable');
    if (scopeTarget.status !== 'known') reasons.push('journal-target-' + scopeTarget.status);
    if (!['saved', 'rolled-back', 'preflight-rejected', 'running', 'preparing', 'applying', 'applied-verified-unsaved', 'needs-attention', 'failed', 'unknown'].includes(status.value)) reasons.push('journal-state-unknown');
    const savedConfirmed = saved.value === true && status.value === 'saved';
    const rollbackConfirmed = !legacy && saved.value === false && status.value === 'rolled-back';
    const writeStarted = data(value, 'writeStarted');
    const preflightRejected = !legacy && saved.value === false && status.value === 'preflight-rejected' && writeStarted.reliable && writeStarted.value === false;
    if (!savedConfirmed && !rollbackConfirmed && !preflightRejected) reasons.push(saved.value === false ? 'unsaved-or-unfinished' : 'completion-not-confirmed');
    const clear = reasons.length === 0 && request.status === 'known';
    findings.push({ source, key, legacy, present: true, status: typeof status.value === 'string' ? status.value : 'unknown', saved: typeof saved.value === 'boolean' ? saved.value : null, target: scopeTarget, scope, state: clear ? 'clear' : 'blocked', code: clear ? null : code, reasons: clear ? [savedConfirmed ? 'saved-confirmed' : rollbackConfirmed ? 'rollback-confirmed' : 'preflight-rejected-before-write'] : reasons });
  }
  return { schemaVersion: 1, kind: 'flitrealize.routing-compatibility', state: findings.some(f => f.state === 'blocked') ? 'blocked' : 'clear', requestedTarget: request, findings };
}

export function assertRoutingCompatibility(report) {
  if (report.state === 'clear') return;
  const code = report.findings.find(f => f.state === 'blocked')?.code ?? 'ROUTING_COMPATIBILITY_UNKNOWN';
  // Native transports retain message/code but may drop extra error properties.
  throw Object.assign(Error(code + ': ' + JSON.stringify(report)), { code, compatibility: report });
}
