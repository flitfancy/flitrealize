#!/usr/bin/env node
/** Use a local parts database first, then acquire missing datasheets. */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

function usage() {
  return [
    'Usage:',
    '  node parts-resolver.mjs --project-root <dir> --database-root <dir>',
    '    --input <parts.json> [--output <manifest.json>]',
    '',
    'Input examples:',
    '  {"parts":[{"lcsc":"C470965"}]}',
    '  {"parts":[{"lcsc":"C536262","manufacturer":"Infineon",',
    '    "mpn":"IM69D130V01","keywords":["PDM","4x3mm"]}]}',
    '  {"parts":[{"mpn":"TPS25221DBVR","url":"https://...pdf"}]}',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  const named = ['--project-root', '--database-root', '--input', '--output'];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (named.includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error('Missing value for ' + argument);
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else {
      throw new Error('Unknown argument: ' + argument);
    }
  }
  return options;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMpn(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function safeName(value) {
  return clean(value).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';
}

function slash(path) {
  return path.replaceAll('\\', '/');
}

function projectPath(projectRoot, value, label) {
  if (!clean(value) || isAbsolute(value)) throw new Error(label + ' must be project-relative');
  const candidate = resolve(projectRoot, value);
  const rel = relative(projectRoot, candidate);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(label + ' leaves the project root');
  }
  return candidate;
}

function httpsUrl(value) {
  if (!clean(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['input must be an object'];
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    return ['parts must contain at least one item'];
  }

  const errors = [];
  const seen = new Set();
  input.parts.forEach((part, index) => {
    const prefix = 'parts[' + index + ']';
    const lcsc = clean(part?.lcsc).toUpperCase();
    const mpn = clean(part?.mpn);
    if (!lcsc && !mpn) errors.push(prefix + ' needs lcsc or mpn');
    if (lcsc && !/^C\d+$/.test(lcsc)) errors.push(prefix + '.lcsc must look like C470965');
    if (clean(part?.currentLcsc) && !/^C\d+$/.test(clean(part.currentLcsc).toUpperCase())) {
      errors.push(prefix + '.currentLcsc must look like C470965');
    }
    if (clean(part?.url) && !httpsUrl(part.url)) errors.push(prefix + '.url must use HTTPS');
    if (part?.keywords !== undefined && (
      !Array.isArray(part.keywords)
      || part.keywords.some((item) => !clean(item))
    )) {
      errors.push(prefix + '.keywords must contain non-empty strings');
    }
    const key = lcsc || normalizeMpn(mpn);
    if (key && seen.has(key)) errors.push(prefix + ' is duplicated');
    seen.add(key);
  });
  return errors;
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function readCachedDirectory(directory) {
  try {
    const [recordText, pdf] = await Promise.all([
      readFile(join(directory, 'part.json'), 'utf8'),
      readFile(join(directory, 'datasheet.pdf')),
    ]);
    if (
      pdf.length < 5
      || pdf.subarray(0, 5).toString('ascii') !== '%PDF-'
    ) {
      return null;
    }
    return JSON.parse(recordText);
  } catch {
    return null;
  }
}

async function findLocalPart(databaseRoot, part) {
  const lcsc = clean(part.lcsc).toUpperCase();
  if (lcsc) {
    const directory = join(databaseRoot, lcsc);
    const record = await readCachedDirectory(directory);
    if (record) return { directory, record };
  }

  const wantedMpn = normalizeMpn(part.mpn);
  if (!wantedMpn) return null;
  const entries = await readdir(databaseRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(databaseRoot, entry.name);
    const record = await readCachedDirectory(directory);
    if (record && normalizeMpn(record.mpn) === wantedMpn) {
      return { directory, record };
    }
  }
  return null;
}

async function fetchLimited(url, fetchImpl, maxBytes, label) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const error = new Error(label + ' failed: HTTP ' + response.status);
    error.httpStatus = response.status;
    throw error;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(label + ' exceeds size limit');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(label + ' exceeds size limit');
  return { bytes, finalUrl: response.url };
}

function productFromJsonLd(html, lcsc) {
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]);
      const candidates = Array.isArray(value) ? value : [value];
      const product = candidates.find((item) => (
        item?.['@type'] === 'Product'
        && clean(item.sku).toUpperCase() === lcsc
      ));
      if (product) return product;
    } catch {
      // Ignore unrelated JSON-LD blocks.
    }
  }
  throw new Error('No matching Product JSON-LD found for ' + lcsc);
}

function datasheetUrl(product, lcsc) {
  const subjects = Array.isArray(product.subjectOf) ? product.subjectOf : [product.subjectOf];
  const document = subjects.find((item) => (
    item
    && httpsUrl(item.url)
    && (/datasheet/i.test(clean(item.name)) || /\.pdf(?:\?|$)/i.test(item.url))
  ));
  if (!document) throw new Error('No datasheet URL found for ' + lcsc);
  return document.url;
}

function parametersFrom(product) {
  const values = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  return values
    .filter((item) => clean(item?.name) && item?.value !== undefined)
    .map((item) => ({ name: clean(item.name), value: String(item.value).trim() }));
}

async function resolveFromLcsc(part, fetchImpl) {
  const lcsc = clean(part.lcsc).toUpperCase();
  const url = 'https://www.lcsc.com/product-detail/' + lcsc + '.html';
  const response = await fetchLimited(url, fetchImpl, MAX_PAGE_BYTES, 'Product lookup for ' + lcsc);
  const product = productFromJsonLd(response.bytes.toString('utf8'), lcsc);
  return {
    requestedLcsc: lcsc,
    currentLcsc: lcsc,
    manufacturer: typeof product.brand === 'object'
      ? clean(product.brand?.name)
      : clean(product.brand),
    mpn: clean(product.mpn),
    description: clean(product.description),
    parameters: parametersFrom(product),
    productPage: response.finalUrl,
    datasheetUrl: datasheetUrl(product, lcsc),
  };
}

function searchQuery(part) {
  const identity = [
    clean(part.manufacturer),
    clean(part.mpn),
    ...(Array.isArray(part.keywords) ? part.keywords.map(clean) : []),
  ].filter(Boolean);
  if (identity.length === 0) identity.push(clean(part.lcsc));
  return [...identity, 'datasheet'].join(' ');
}

async function storePart(databaseRoot, part, resolvedPart, options) {
  const key = clean(part.lcsc).toUpperCase() || 'MPN_' + safeName(resolvedPart.mpn);
  const directory = join(databaseRoot, key);
  const pdfPath = join(directory, 'datasheet.pdf');
  const response = await fetchLimited(
    resolvedPart.datasheetUrl,
    options.fetchImpl,
    MAX_PDF_BYTES,
    'Datasheet download for ' + resolvedPart.mpn,
  );
  if (
    response.bytes.length < 5
    || response.bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
  ) {
    throw new Error('Downloaded content is not a PDF for ' + resolvedPart.mpn);
  }

  await atomicWrite(pdfPath, response.bytes);
  const sha256 = createHash('sha256').update(response.bytes).digest('hex');
  const record = {
    version: 1,
    ...(clean(part.lcsc) ? { requestedLcsc: clean(part.lcsc).toUpperCase() } : {}),
    ...(clean(resolvedPart.currentLcsc) ? {
      currentLcsc: clean(resolvedPart.currentLcsc).toUpperCase(),
    } : {}),
    manufacturer: clean(resolvedPart.manufacturer),
    mpn: clean(resolvedPart.mpn),
    ...(clean(resolvedPart.description) ? { description: clean(resolvedPart.description) } : {}),
    ...(resolvedPart.parameters?.length ? { parameters: resolvedPart.parameters } : {}),
    ...(clean(resolvedPart.productPage) ? { productPage: resolvedPart.productPage } : {}),
    datasheetUrl: response.finalUrl || resolvedPart.datasheetUrl,
    pdfSha256: sha256,
    pdfBytes: response.bytes.length,
    downloadedAt: (options.now ? options.now() : new Date()).toISOString(),
  };
  await atomicWrite(
    join(directory, 'part.json'),
    Buffer.from(JSON.stringify(record, null, 2) + '\n'),
  );
  return { directory, record };
}

async function processPart(databaseRoot, part, options) {
  const local = await findLocalPart(databaseRoot, part);
  if (local) {
    return {
      lcsc: clean(part.lcsc).toUpperCase() || undefined,
      mpn: local.record.mpn,
      result: 'local',
      localData: slash(local.directory),
    };
  }

  let resolvedPart;
  if (httpsUrl(part.url) && clean(part.mpn)) {
    resolvedPart = {
      requestedLcsc: clean(part.lcsc).toUpperCase(),
      currentLcsc: clean(part.currentLcsc).toUpperCase(),
      manufacturer: clean(part.manufacturer),
      mpn: clean(part.mpn),
      datasheetUrl: part.url,
    };
  } else if (clean(part.lcsc)) {
    try {
      resolvedPart = await resolveFromLcsc(part, options.fetchImpl);
    } catch (error) {
      return {
        lcsc: clean(part.lcsc).toUpperCase(),
        ...(clean(part.mpn) ? { mpn: clean(part.mpn) } : {}),
        result: 'needs_lookup',
        query: searchQuery(part),
        reason: error.message,
      };
    }
  } else {
    return {
      mpn: clean(part.mpn),
      result: 'needs_lookup',
      query: searchQuery(part),
      reason: 'No datasheet URL was supplied.',
    };
  }

  try {
    const stored = await storePart(databaseRoot, part, resolvedPart, options);
    return {
      ...(clean(part.lcsc) ? { lcsc: clean(part.lcsc).toUpperCase() } : {}),
      mpn: stored.record.mpn,
      result: 'downloaded',
      localData: slash(stored.directory),
    };
  } catch (error) {
    return {
      ...(clean(part.lcsc) ? { lcsc: clean(part.lcsc).toUpperCase() } : {}),
      ...(clean(resolvedPart.mpn) ? { mpn: clean(resolvedPart.mpn) } : {}),
      result: 'error',
      error: error.message,
    };
  }
}

export async function generateDatasheets(input, options = {}) {
  const errors = validateInput(input);
  if (errors.length > 0) throw new Error('Invalid parts input:\n- ' + errors.join('\n- '));

  const projectRoot = realpathSync(resolve(options.projectRoot || '.'));
  const databaseRoot = resolve(options.databaseRoot || '');
  if (!clean(options.databaseRoot)) throw new Error('databaseRoot is required');
  await mkdir(databaseRoot, { recursive: true });
  const outputPath = projectPath(
    projectRoot,
    options.outputPath || 'parts/DATASHEET_MANIFEST.json',
    'output',
  );
  const processing = {
    fetchImpl: options.fetchImpl || fetch,
    now: options.now,
  };
  const results = [];
  for (const part of input.parts) {
    results.push(await processPart(databaseRoot, part, processing));
  }

  const manifest = {
    version: 1,
    generatedAt: (options.now ? options.now() : new Date()).toISOString(),
    databaseRoot: slash(databaseRoot),
    results,
  };
  await atomicWrite(outputPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { manifest, outputPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!options.projectRoot || !options.databaseRoot || !options.input) {
    throw new Error('--project-root, --database-root and --input are required\n\n' + usage());
  }
  const projectRoot = realpathSync(resolve(options.projectRoot));
  const input = JSON.parse(await readFile(projectPath(projectRoot, options.input, 'input'), 'utf8'));
  const result = await generateDatasheets(input, {
    projectRoot,
    databaseRoot: options.databaseRoot,
    outputPath: options.output,
  });
  process.stdout.write(JSON.stringify({
    manifest: slash(relative(projectRoot, result.outputPath)),
    results: result.manifest.results,
  }, null, 2) + '\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
