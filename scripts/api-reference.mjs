#!/usr/bin/env node
import { isDirectExecution } from './lib/cli-entrypoint.mjs';
import { loadCorpus, searchReference, showReference } from './lib/api-reference.mjs';

const help = `Offline EasyEDA API reference lookup (historical snapshot; no EDA calls).
node scripts/api-reference.mjs search --query <text> [--kind class|interface|enum|type|method|property] [--limit 8]
node scripts/api-reference.mjs show --id <entry or entry#member> [--full]
Default output is a summary. --full returns the complete selected definition.
Lookup never executes examples, writes reports, starts the bridge or fetches a URL.`;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export async function main(args = process.argv.slice(2), { output = value => console.log(JSON.stringify(value)) } = {}) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const [command, ...rest] = args;
  if (!['search', 'show'].includes(command)) fail('INVALID_COMMAND', 'Use search, show or --help.');
  const allowed = new Set(command === 'search' ? ['--query', '--kind', '--limit'] : ['--id', '--full']);
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!allowed.has(flag)) fail('UNKNOWN_OPTION', flag);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) fail('DUPLICATE_OPTION', flag);
    if (key === 'full') { options.full = true; continue; }
    const value = rest[++index];
    if (value === undefined || value.startsWith('--')) fail('MISSING_OPTION_VALUE', flag);
    options[key] = key === 'limit' ? Number(value) : value;
  }
  const corpus = await loadCorpus();
  const result = command === 'search' ? searchReference(corpus, options) : showReference(corpus, options);
  output(result);
  return result;
}

if (isDirectExecution(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ status: 'error', readOnly: true, error: { code: error.code ?? 'REFERENCE_FAILED', message: error.message } })); process.exitCode = 1; });
}
