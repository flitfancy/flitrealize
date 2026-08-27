#!/usr/bin/env node
/** Run every repository Node test through one cross-platform entrypoint. */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = join(root, 'tests');
const testFiles = (await readdir(testRoot))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(testRoot, name));

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
