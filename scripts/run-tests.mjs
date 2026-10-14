#!/usr/bin/env node
/** Run every repository Node test through one cross-platform entrypoint. */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const excludedDirectories = new Set(['fixtures', 'helpers', 'manual', '__pycache__', 'node_modules']);
async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) return collectTests(file);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [file] : [];
  }))).flat();
}
const testFiles = (await collectTests(join(root, 'tests'))).sort();

if (testFiles.length === 0) {
  process.stderr.write('No Node test files found.\n');
  process.exitCode = 1;
} else {
  const completed = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...testFiles], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (completed.error) throw completed.error;
  process.exitCode = completed.status ?? 1;
}
