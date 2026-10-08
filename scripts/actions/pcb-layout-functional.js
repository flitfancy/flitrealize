return await (async()=>{
  const {pathToFileURL}=await import('node:url');
  const base=new URL('../',pathToFileURL(flitrealizeContext.actionFile)),input=flitrealizeInput;
  const {prepareLayoutInputs}=await import(new URL('pcb-layout/pcb-layout-prepare.mjs',base));
  const prepared=prepareLayoutInputs(input.bundle);if(!prepared.state.ready)throw Error('FUNCTIONAL_LAYOUT_INPUT_NOT_READY');
  if((input.mode??'semantic')==='semantic'){
    const {convertSemanticInputs}=await import(new URL('pcb-layout/pcb-layout-semantic.mjs',base));return{status:'planned',semantic:convertSemanticInputs(prepared.model,input.semanticPolicy),nativeWrites:0};
  }
  if(input.mode==='solve'){
    const {runCpsatLayout}=await import(new URL('pcb-layout/pcb-layout-cpsat.mjs',base)),{resolvePcbPython}=await import(new URL('lib/pcb-python.mjs',base));
    const result=await runCpsatLayout(prepared.model,input.settings,{...input.options,runtime:{pythonPath:resolvePcbPython({python:input.python})},semanticPolicy:input.semanticPolicy});
    return{...result,operationStatus:result.status,status:result.candidates.length?'planned':'blocked'};
  }
  throw Error('FUNCTIONAL_LAYOUT_MODE');
})();
