import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Execute real Actions against an isolated scene and return the runner report envelope. */
export function pcbActionExecutor(eda, actionRoot = fileURLToPath(new URL('../../scripts/actions/easyeda-pro/', import.meta.url))) {
  const functions = new Map();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return async (action, input, context) => {
    if (!functions.has(action)) functions.set(action, new AsyncFunction('eda', 'flitrealizeInput', await readFile(join(actionRoot, action + '.js'), 'utf8')));
    let response;
    try { response = { success: true, result: await functions.get(action)(eda, input) }; }
    catch (error) { response = { success: false, status: 'error', error: { code: error.code || 'ACTION_ERROR', message: error.message } }; }
    return { schemaVersion: 2, action, runtime: 'eda', provider: 'easyeda-pro', mode: input.mode,
      mutates: context.mutates, projectRoot: context.projectRoot, capturedAt: new Date().toISOString(), response };
  };
}
