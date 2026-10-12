return await (async () => {
  const native = await layoutNative(eda, layoutExecutionInput);
  const document = await native.target();
  const source = await eda.sys_FileManager.getDocumentSource();
  if (typeof source !== 'string' || !source.trim()) native.fail('SOURCE_UNAVAILABLE');
  await native.target();
  return { status: 'source-checked', sourceHash: native.sourceHash(source), document };
})();
