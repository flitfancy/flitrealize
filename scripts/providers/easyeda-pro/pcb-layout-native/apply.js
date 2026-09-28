return await (async () => {
  const n = await layoutNative(eda, layoutExecutionInput), { plan, snapshot } = layoutExecutionInput;
  try { const live = await n.read(); n.checkPlan(live); }
  catch (error) { return { status: 'blocked', saved: false, attempted: [], error: { code: 'LAYOUT_PREFLIGHT_FAILED', message: error.message } }; }
  const attempted = [];
  try {
    for (const c of plan.components) if (n.moved(snapshot.components.find(a => a.id === c.id), c)) { attempted.push(c.id); if (!await eda.pcb_PrimitiveComponent.modify(c.id, { x: c.x, y: c.y, rotation: c.rotation })) n.fail('COMPONENT_MOVE_FAILED ' + c.ref); }
    for (const l of plan.labels) {
      const old = snapshot.items.find(a => a.id === l.id), componentMoved = n.moved(snapshot.components.find(c => c.ref === l.owner), plan.components.find(c => c.ref === l.owner));
      if (!componentMoved && !n.moved(old.original, l) && old.original.alignMode === l.alignMode) continue;
      attempted.push(l.id);
      const api = l.type === 'attribute' ? eda.pcb_PrimitiveAttribute : eda.pcb_PrimitiveString;
      if (!await api.modify(l.id, { x: l.x, y: l.y, rotation: l.rotation, alignMode: l.alignMode })) n.fail('LABEL_MOVE_FAILED ' + l.id);
    }
    for (const p of plan.testPads) if (n.moved(snapshot.pads.find(a => a.id === p.id), p)) { attempted.push(p.id); if (!await eda.pcb_PrimitivePad.modify(p.id, { x: p.x, y: p.y })) n.fail('TESTPAD_MOVE_FAILED ' + p.id); }
    const after = await n.verify();
    if (after.issues.length) return { status: 'apply-verification-failed', saved: false, attempted, after };
    return { status: 'applied', saved: false, attempted, after, sourceHash: after.sourceHash };
  } catch (error) {
    let current = null; try { current = await n.read(); } catch {}
    return { status: 'partial-failed', saved: false, attempted, error: { code: 'NATIVE_APPLY_FAILED', message: error.message }, current };
  }
})();
