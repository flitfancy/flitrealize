import { readFile } from 'node:fs/promises';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function loadAction(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid action name: ' + name);
  const code = await readFile(new URL('../../scripts/actions/' + name + '.js', import.meta.url), 'utf8');
  return new AsyncFunction('eda', 'flitrealizeInput', code);
}
