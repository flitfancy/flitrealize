import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
export { layoutRealization, labelAlignment, normalizeCoordinateSystem } from './pcb-layout-input.mjs';

export function validateContext(options) {
  if (typeof options?.windowId !== 'string' || !options.windowId.trim()) throw Object.assign(Error('A confirmed EasyEDA windowId is required.'), { code: 'LAYOUT_CONTEXT_REQUIRED' });
}

export function target(config) {
  if (!config || !['expectedProjectUuid', 'expectedDocumentUuid'].every(k => typeof config[k] === 'string' && config[k].trim())) {
    throw Object.assign(Error('TARGET_REQUIRED'), { code: 'TARGET_REQUIRED' });
  }
  return { expectedProjectUuid: config.expectedProjectUuid, expectedDocumentUuid: config.expectedDocumentUuid };
}

export async function buildOperation(phase, input) {
  if (!['inspect', 'apply', 'verify', 'save'].includes(phase)) throw Error('UNSUPPORTED_LAYOUT_OPERATION');
  const { assemblyRuntime } = await import('../../pcb-layout/pcb-layout-assembly-policy.mjs');
  const runtime = await readFile(new URL('./pcb-layout-native/runtime.js', import.meta.url), 'utf8');
  const body = await readFile(new URL('./pcb-layout-native/' + phase + '.js', import.meta.url), 'utf8');
  return {
    extension: '.js',
    code: 'const layoutExecutionInput=' + JSON.stringify(input) + ';\nconst assemblyRuntime=(' + assemblyRuntime.toString() + ');\n' + runtime + '\n' + body,
  };
}

export async function execute({ codeFile, windowId }) {
  const host = fileURLToPath(new URL('../../eda-host.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath,
    [host, 'execute', '--eda', 'easyeda-pro', '--window-id', windowId, '--code-file', codeFile],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  return JSON.parse(stdout.trim());
}
