// Read local API documentation as data; never execute its examples.
const { dirname, resolve } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { loadCorpus, searchReference, showReference } = await import(pathToFileURL(resolve(dirname(flitrealizeContext.actionFile), '../lib/api-reference.mjs')).href);
const input = flitrealizeInput ?? {}, corpus = await loadCorpus();
if ((input.mode ?? 'search') === 'search') return searchReference(corpus, { query: input.query, kind: input.kind, limit: input.limit });
if (input.mode === 'show') return showReference(corpus, { id: input.id, full: input.full });
throw Error('INVALID_MODE');
