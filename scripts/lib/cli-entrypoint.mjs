import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Detect CLI execution through real paths, symlinks and Windows junctions. */
export function isDirectExecution(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  const canonical = path => {
    const real = realpathSync.native(resolve(path));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  try {
    return canonical(entry) === canonical(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
