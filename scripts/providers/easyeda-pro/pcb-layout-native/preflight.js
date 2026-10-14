return await (async () => {
  const n=await layoutNative(eda,layoutExecutionInput),live=await n.read();
  try { const geometry=n.checkPlan(live);return {status:'preflight-passed',nativeWrites:0,live,geometry}; }
  catch(error){return {status:'preflight-blocked',nativeWrites:0,live,error:{code:error.message.split(' ')[0],message:error.message}};}
})();
