#!/usr/bin/env node
// Compatibility spelling only. The authoritative entry is pcb-layout.mjs fine.
import { isDirectExecution } from './lib/cli-entrypoint.mjs';
import { main } from './pcb-layout/fine/cli.mjs';
export { main };
if(isDirectExecution(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'failed',code:error.code,error:error.message}));process.exitCode=1;});
