return await (async () => {
  const n = await layoutNative(eda, layoutExecutionInput);
  try {
    await n.target();
    const source = await eda.sys_FileManager.getDocumentSource();
    if (n.sourceHash(source) !== layoutExecutionInput.expectedSourceHash) n.fail('SOURCE_CHANGED_RECONCILE');
  } catch (error) { return { status: 'save-blocked', saved: false, error: { code: 'LAYOUT_SAVE_PREFLIGHT_FAILED', message: error.message } }; }
  const saved = await eda.pcb_Document.save();
  return saved === true ? { status: 'saved', saved: true } : { status: 'save-failed', saved: false, error: { code: 'SAVE_FAILED', message: 'EDA did not confirm saving.' } };
})();
