return await (async()=>{
  const {pathToFileURL}=await import('node:url');
  const {runBlockLayout}=await import(new URL('../pcb-block-layout.mjs',pathToFileURL(flitrealizeContext.actionFile)));
  const result=await runBlockLayout({...flitrealizeInput,mode:flitrealizeInput.mode??'pack'},{python:flitrealizeInput.python});
  const failed=['failed','verification-failed','no-candidate'].includes(result.status);
  return{...result,operationStatus:result.status,status:failed?'blocked':flitrealizeInput.mode==='verify'?'verified':'planned',nativeWrites:0};
})();
