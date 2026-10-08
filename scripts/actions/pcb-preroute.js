return await (async()=>{
  const {pathToFileURL}=await import('node:url');
  const {runPrerouteStudy,studyOutputDirectory}=await import(new URL('../pcb-preroute.mjs',pathToFileURL(flitrealizeContext.actionFile)));
  const {realpath}=await import('node:fs/promises'),root=await realpath(flitrealizeContext.projectRoot);
  const directory=await studyOutputDirectory(root,flitrealizeInput.output);
  const result=await runPrerouteStudy(flitrealizeInput,{directory,python:flitrealizeInput.python,timeoutMs:flitrealizeInput.timeoutMs});
  const status=['failed','blocked'].includes(result.status)?result.status:result.mode==='verify'?'verified':['ground','diagnose','scan','paths','repair-plan'].includes(result.mode)?'inspected':'planned';
  return {...result.summary,operationStatus:result.status,status,summary:result.summary};
})();
