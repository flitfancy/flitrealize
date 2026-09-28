if ((flitrealizeInput.mode ?? 'pack') !== 'pack') throw Error('INVALID_MODE');
const { pathToFileURL } = await import('node:url');
const { dirname, resolve } = await import('node:path');
const { packFineLayout } = await import(pathToFileURL(resolve(dirname(flitrealizeContext.actionFile), '../pcb-layout/pcb-gravity-pack.mjs')).href);
const result = packFineLayout(flitrealizeInput);
return { ...result, packingStatus: result.status, status: result.status === 'packed-candidate' ? 'generated' : 'inspected-with-gaps' };
