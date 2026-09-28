import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogModel, catalogReport, renderCatalogSvg } from '../scripts/pcb-layout/pcb-layout-catalog-report.mjs';

const box = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });
function fixture() {
  const source = { id: 'c1', ref: 'C1', x: 10, y: 20, rotation: 0, body: box(8, 16, 12, 24) };
  const snapshot = { components: [source], pads: [{ id: 'c1.pad1', owner: 'C1', number: '1', net: 'SYS', bbox: box(11, 19, 13, 21) }, { id: 'tp1', owner: null, number: 'TP1', net: 'SYS', bbox: box(40, 40, 42, 42) }] };
  const contract = { blocks: [{ id: 'power', components: ['C1'] }] };
  const candidate = (name, score) => ({ name, label: name, comparisonScore: score,
    plan: { components: [{ ref: 'C1', x: 100, y: 200, rotation: 90, body: box(96, 198, 104, 202) }],
      labels: [{ id: 'label1', text: 'C1', fontSize: 4, rotation: 90, bbox: box(105, 198, 109, 204) }],
      testPads: [{ id: 'tp1', owner: null, number: 'TP1', net: 'SYS', bbox: box(140, 240, 142, 242) }], counts: { moved: 1, rotated: 1, silkRelocated: 0 } },
    metrics: { groups: { power: { label: '功率连接', mil: 80, count: 1 } }, geometry: { hugeUnusedField: 'large-data'.repeat(10000) } },
    validation: { valid: true, issues: [], minimumGapMil: 20, edge: { envelope: box(96, 198, 142, 242) } },
    scores: { electrical: score, spacing: 0, total: score } });
  const baseline = candidate('baseline', 1); baseline.metrics.groups.power.mil = 100;
  return { snapshot, contract, candidate, baseline, config: {} };
}
const encodedModel = html => JSON.parse(html.match(/<script id="catalog-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);

test('catalog sorts by supplied score without mutating candidates or carrying full geometry results', () => {
  const f = fixture(), inputs = [f.candidate('high', 1.2), f.candidate('low', .8)];
  const before = structuredClone(inputs);
  const model = catalogModel(inputs, f.baseline, f.config, f.contract, f.snapshot, { runId: 'run1' });
  assert.deepEqual(model.candidates.map(c => [c.id, c.number]), [['low', 1], ['high', 2]]);
  assert.deepEqual(inputs, before);
  assert.equal(model.candidates[0].groups[0].baselineMil, 100);
  assert.equal(model.footprints.C1.pads.length, 1);
  assert.equal(JSON.stringify(model).includes('hugeUnusedField'), false);
  assert.equal(model.candidates[0].spacing, null);
});

test('detailed geometry uses actual quarter-turn transformed pads, candidate test pads and native Y-up text', () => {
  const f = fixture(), model = catalogModel([f.candidate('one', 1)], f.baseline, f.config, f.contract, f.snapshot);
  const svg = renderCatalogSvg(model.candidates[0], model, true);
  assert.match(svg, /<title>C1\.1 · SYS<\/title><rect x="99" y="-203" width="2" height="2"/);
  assert.match(svg, /<title>TP1 · SYS<\/title><rect x="140" y="-242" width="2" height="2"/);
  assert.match(svg, /x="107" y="-201"[^>]*transform="rotate\(-90 107 -201\)"/);
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
  assert.equal((svg.match(/<title>TP1/g) ?? []).length, 1);
  const thumbnail = renderCatalogSvg(model.candidates[0], model, false);
  assert.equal(thumbnail.includes('C1.1'), false);
  assert.equal(thumbnail.includes('<text'), false);
  assert.match(thumbnail, /x="96" y="-202" width="8" height="4"/);
});

test('all candidates share one viewBox so thumbnails do not conceal differing whitespace', () => {
  const f = fixture(), first = f.candidate('a', 1), second = f.candidate('b', 2);
  second.plan.components[0].body = box(300, 100, 308, 104);
  const model = catalogModel([first, second], f.baseline, f.config, f.contract, f.snapshot);
  const boxes = model.candidates.map(c => renderCatalogSvg(c, model, false).match(/viewBox="([^"]+)"/)[1]);
  assert.equal(boxes[0], boxes[1]);
  assert.ok(model.viewBox[0] < 96 && model.viewBox[0] + model.viewBox[2] > 308);
  assert.ok(-model.viewBox[1] > 242);
});

test('untrusted strings cannot close the embedded script or create SVG markup', () => {
  const f = fixture(), c = f.candidate('</script><img src=x onerror=alert(1)>', .9);
  c.plan.labels[0].text = '<svg onload=alert(2)>&';
  const html = catalogReport([c], f.baseline, f.config, f.contract, f.snapshot, { runId: '</script>evil', sourceLabel: '<img src=x onerror=alert(3)>' });
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('</script>evil'), false);
  const model = encodedModel(html);
  assert.equal(model.runId, '</script>evil');
  assert.equal(model.candidates[0].id, c.name);
  const svg = renderCatalogSvg(model.candidates[0], model);
  assert.match(svg, /&lt;svg onload=alert\(2\)&gt;&amp;/);
  assert.equal(svg.includes('<svg onload'), false);
});

test('reports without assembly input limit their claim to the configured conditions', () => {
  const f = fixture(), args = [[f.candidate('one', 1)], f.baseline, f.config, f.contract, f.snapshot];
  const html = catalogReport(...args);
  assert.match(html, /仅比较当前已定义规则下的候选/);
  assert.equal(encodedModel(html).derivedSpacing, false);
});

test('100 candidates are embedded once and the initial DOM contains only dynamic grid placeholders', () => {
  const f = fixture(), candidates = Array.from({ length: 100 }, (_, i) => f.candidate('c' + i, i + 1));
  const html = catalogReport(candidates, f.baseline, f.config, f.contract, f.snapshot, { runId: 'hundred' });
  const model = encodedModel(html);
  assert.equal(model.candidates.length, 100);
  assert.equal(model.pageSize, 20);
  assert.equal(model.candidates[99].number, 100);
  assert.equal(html.includes('hugeUnusedField'), false);
  assert.equal(html.includes('<div id="catalog-grid" class="catalog-grid"></div>'), true);
  assert.ok(html.length < 150000);
});

test('invalid geometry and duplicate candidate identities are rejected before producing a misleading catalog', () => {
  const f = fixture(), one = f.candidate('one', 1), args = [f.baseline, f.config, f.contract, f.snapshot];
  assert.throws(() => catalogModel([one, one], ...args), /CATALOG_DUPLICATE_ID/);
  const invalid = f.candidate('invalid', 2); invalid.plan.components[0].body.maxX = NaN;
  assert.throws(() => catalogModel([invalid], ...args), /CATALOG_INVALID_NUMBER/);
  assert.throws(() => catalogModel([], ...args), /CATALOG_EMPTY/);
  const unknown = f.candidate('unknown', 3); unknown.plan.components[0].ref = 'R9';
  assert.throws(() => catalogModel([unknown], ...args), /CATALOG_SOURCE_COMPONENT_MISSING/);
});

test('a failed candidate remains visibly failed and is never relabeled assembly-safe', () => {
  const f = fixture(), c = f.candidate('bad', 1);
  c.validation = { valid: false, issues: [{ code: 'GEOMETRY_MISSING', refs: ['C1', 'R1'] }], minimumGapMil: null };
  const model = catalogModel([c], f.baseline, f.config, f.contract, f.snapshot, {});
  assert.equal(model.candidates[0].valid, false);
  assert.equal(model.candidates[0].minGapMil, null);
  assert.deepEqual(model.candidates[0].issues, [{ code: 'GEOMETRY_MISSING', object: 'C1, R1' }]);
});
