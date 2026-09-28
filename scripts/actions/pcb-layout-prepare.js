// Host-only preparation of an explicit input bundle. No EDA calls or file writes.
if ((flitrealizeInput.mode ?? 'prepare') !== 'prepare') throw Error('INVALID_MODE');
const { pathToFileURL } = await import('node:url');
const { dirname, resolve } = await import('node:path');
const { prepareLayoutInputs } = await import(pathToFileURL(resolve(dirname(flitrealizeContext.actionFile), '../pcb-layout/pcb-layout-prepare.mjs')).href);
const { model, ...result } = prepareLayoutInputs(flitrealizeInput);
return { status: result.state.ready ? 'prepared' : 'blocked', ...result };
