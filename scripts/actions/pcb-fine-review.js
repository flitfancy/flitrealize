// Offline comparison of an observed PCB and explicit local placement scenarios.
if ((flitrealizeInput.mode ?? 'review') !== 'review') throw Error('INVALID_MODE');
const { pathToFileURL } = await import('node:url');
const { dirname, resolve } = await import('node:path');
const { reviewFineLayout } = await import(pathToFileURL(resolve(dirname(flitrealizeContext.actionFile), '../pcb-layout/pcb-layout-fine-review.mjs')).href);
const result = reviewFineLayout(flitrealizeInput.snapshot, flitrealizeInput.request, flitrealizeInput.assemblyRules);
return { ...result, reviewStatus: result.status, status: result.status === 'reviewed' ? 'inspected' : 'inspected-with-gaps' };
