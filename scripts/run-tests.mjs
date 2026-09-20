#!/usr/bin/env node
/** Run every repository Node test through one cross-platform entrypoint. */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoots = [join(root, 'tests'), join(root, 'view-state', 'tests')];
const testFiles = (await Promise.all(testRoots.map(async (testRoot) =>
  (await readdir(testRoot))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(testRoot, name))
))).flat();

if (testFiles.length === 0) {
  process.stderr.write('No Node test files found.\n');
  process.exitCode = 1;
} else {
  const completed = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (completed.error) throw completed.error;
  process.exitCode = completed.status ?? 1;
}
