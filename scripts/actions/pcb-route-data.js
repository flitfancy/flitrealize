return await (async()=>{
 const {pathToFileURL}=await import('node:url');
 const url=new URL('../pcb-routing/model.mjs',pathToFileURL(flitrealizeContext.actionFile));
 const model=await import(url);
 if((flitrealizeInput.mode??'generate')==='generate')return{status:'planned',tasks:model.compileTasks(flitrealizeInput.board,flitrealizeInput.policy,flitrealizeInput.selection??{})};
 if(flitrealizeInput.mode==='verify'){const result=model.validateCandidate(flitrealizeInput.board,flitrealizeInput.task,flitrealizeInput.candidate,flitrealizeInput.input);return{status:result.passed?'passed':'blocked',...result};}
 throw Error('INVALID_ROUTING_DATA_MODE');
})();
