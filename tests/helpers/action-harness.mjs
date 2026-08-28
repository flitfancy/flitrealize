import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function loadAction(name, provider = null) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid action name: ' + name);
  const baseDir = new URL('../../scripts/actions/', import.meta.url);
  const candidates = provider
    ? [new URL(provider + '/' + name + '.js', baseDir), new URL(name + '.js', baseDir)]
    : [new URL(name + '.js', baseDir)];
  for (const url of candidates) {
    if (existsSync(url)) {
      const code = await readFile(url, 'utf8');
      return new AsyncFunction('eda', 'flitrealizeInput', code);
    }
  }
  throw new Error('Action file not found: ' + name + (provider ? ' (provider: ' + provider + ')' : ''));
}
