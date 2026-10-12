import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Mixed algorithm/evidence modules remain whole-file dependencies. Only these
// standalone HTML presentation modules are excluded from candidate identity.
const presentation = new Set(['solver-report', 'catalog-report', 'model-report', 'report-ui', 'spacing-report', 'spacing-policy-report'].map(name => 'scripts/pcb-layout/pcb-layout-' + name + '.mjs'));
const nativePhases = ['inspect', 'apply', 'verify', 'save'];
// These resources are loaded by generated paths or by a child process rather
// than an ES import. Keep each edge beside its owning implementation.
const dynamicDependencies = {
  'scripts/providers/easyeda-pro/pcb-layout.mjs': nativePhases.map(phase => 'scripts/providers/easyeda-pro/pcb-layout-native/' + phase + '.js'),
  'scripts/eda-host.mjs': ['scripts/providers/easyeda-pro/cli-channel.mjs', 'adapters/easyeda-pro/scripts/bridge-control.mjs', 'adapters/easyeda-pro/package.json', 'adapters/easyeda-pro/package-lock.json'],
  'adapters/easyeda-pro/scripts/bridge-control.mjs': ['adapters/easyeda-pro/scripts/bridge-server.mjs'],
};
const dynamicImports = { 'scripts/eda-host.mjs': ['module.href'] };
const dynamicResources = {
  'scripts/providers/easyeda-pro/pcb-layout.mjs': ["'./pcb-layout-native/' + phase + '.js'"],
  'scripts/eda-host.mjs': ['`./providers/${eda}/cli-channel.mjs`'],
};
const declared = (table, file, expression) => (table[file] ?? []).some(value => value.replace(/\s/g, '') === expression.replace(/\s/g, ''));
const roots = ['scripts/pcb-layout.mjs', 'scripts/pcb-block-layout.mjs', 'schemas/pcb-layout-intent.v1.schema.json'];
const digest = value => createHash('sha256').update(value).digest('hex');

function dependencyContent(file, content) {
  // Host execution reads provider kind, not action descriptions/workflows.
  if (file === 'scripts/actions/manifest.json') return JSON.stringify({ easyedaProKind: JSON.parse(content).providers?.['easyeda-pro']?.kind ?? null });
  if (file === 'adapters/easyeda-pro/package.json') {
    const p = JSON.parse(content);
    return JSON.stringify({ type: p.type, dependencies: p.dependencies, optionalDependencies: p.optionalDependencies });
  }
  if (file === 'adapters/easyeda-pro/package-lock.json') {
    const p = JSON.parse(content);
    return JSON.stringify({ lockfileVersion: p.lockfileVersion, packages: Object.fromEntries(Object.entries(p.packages).map(([key, value]) => [key, key ? value : { dependencies: value.dependencies, optionalDependencies: value.optionalDependencies }])) });
  }
  return content;
}

/** Read-only closure of bundled layout code and declared dynamic resources.
 * Registered external adapters, EDA binaries and Python installations are
 * runtime choices; this identifies the bundled implementation, not those files. */
export async function layoutImplementationRecords(skillRoot, { entrypoints = [] } = {}) {
  const root = path.resolve(skillRoot), records = new Map();
  if (!Array.isArray(entrypoints) || entrypoints.some(file => typeof file !== 'string' || file.includes('\\') || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.posix.normalize(file).startsWith('../') || !/\.(mjs|js)$/.test(file))) throw Error('INVALID_LAYOUT_ENGINE_ENTRYPOINT');
  const relativeDependency = (owner, reference) => {
    if (!reference.startsWith('.')) return null; // node: and installed packages
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(owner), reference));
    if (file.startsWith('../') || path.posix.isAbsolute(file)) throw Error('LAYOUT_ENGINE_DEPENDENCY_OUTSIDE_SKILL ' + owner);
    return file;
  };
  async function visit(file) {
    if (presentation.has(file) || records.has(file)) return;
    const content = await fs.readFile(path.join(root, file), 'utf8');
    records.set(file, digest(dependencyContent(file, content)));
    if (!/\.(mjs|js)$/.test(file)) return;
    const references = [];
    for (const match of content.matchAll(/\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"]([^'"]+)['"]/g)) references.push(match[1]);
    for (const match of content.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
      const literal = /^(['"])([^'"]+)\1\s*$/.exec(match[1]);
      if (literal) references.push(literal[2]);
      else if (!declared(dynamicImports, file, match[1])) throw Error('LAYOUT_ENGINE_UNDECLARED_DYNAMIC_IMPORT ' + file);
    }
    for (const match of content.matchAll(/new URL\(\s*([^,]+),\s*import\.meta\.url\s*\)/g)) {
      const literal = /^(['"])([^'"]+)\1\s*$/.exec(match[1]);
      if (literal) { if (/\.(mjs|js|py|json)$/.test(literal[2])) references.push(literal[2]); }
      else if (!declared(dynamicResources, file, match[1])) throw Error('LAYOUT_ENGINE_UNDECLARED_DYNAMIC_RESOURCE ' + file);
    }
    if (file === 'scripts/pcb-layout/pcb-layout-execution.mjs') {
      for (const match of content.matchAll(/(?:invoke\(ctx,\s*|step\(\s*)['"]([^'"]+)['"]/g)) {
        if (!nativePhases.includes(match[1])) throw Error('LAYOUT_ENGINE_UNDECLARED_NATIVE_PHASE ' + match[1]);
      }
    }
    for (const reference of references) {
      const dependency = relativeDependency(file, reference);
      if (dependency) await visit(dependency);
    }
    for (const dependency of dynamicDependencies[file] ?? []) await visit(dependency);
  }
  for (const file of [...roots, ...entrypoints.map(file => path.posix.normalize(file))]) await visit(file);
  return [...records].sort((a, b) => a[0].localeCompare(b[0]));
}
