import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { initializeReport } from '../scripts/pcb-layout/pcb-layout-report-ui.mjs';
import { score } from '../scripts/pcb-layout/pcb-layout-solver-core.mjs';
import { comparisonReport } from '../scripts/pcb-layout/pcb-layout-solver-report.mjs';

test('report controls match solver scoring, reject invalid inputs and reset without changing layout', () => {
  const element = extra => ({ ...extra, addEventListener(name, fn) { this[name] = fn; }, classList: { toggle() {} } });
  const initialWeights = { sense: 5, connectivity: 1, uniformity: .08 };
  const inputs = Object.entries(initialWeights).map(([key, value]) => element({ dataset: { weight: key }, value: String(value) }));
  const status = element({}), reset = element({}), exportButton = element({}), sections = [element({ id: 'a' }), element({ id: 'b' })], scores = { a: element({}), b: element({}) };
  const data = { initialWeights, groups: ['sense', 'connectivity'], candidates: [{ name: 'a', label: 'A', ratios: { sense: 1, connectivity: 1 }, uniformity: 0 }, { name: 'b', label: 'B', ratios: { sense: .8, connectivity: 1.3 }, uniformity: 2 }] };
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelectorAll: s => s === '[data-weight]' ? inputs : s === 'section' ? sections : s === '[data-score]' ? Object.values(scores) : [],
    getElementById: id => ({ 'weight-status': status, 'reset-weights': reset, 'export-weights': exportButton })[id],
    querySelector: s => scores[/data-score="(.*?)"/.exec(s)[1]]
  };
  try {
    initializeReport(data);
    data.candidates[0].valid = false;
    inputs[0].input();
    assert.ok(!status.textContent.includes('A ('));
    const check = weights => {
      const model = { config: { groups: [{ id: 'sense' }] }, scoreReferences: { groups: { sense: { mil: 100 }, connectivity: { mil: 100 } } } };
      const metrics = { groups: { sense: { mil: 80 }, connectivity: { mil: 130 } }, displacementMil: 200, rotationFraction: .3, silkFraction: .4, spatial:{penalties:{uniformity:2}} };
      assert.equal(scores.b.textContent, score(model, metrics, weights).toFixed(4));
    };
    check(initialWeights);
    inputs[1].value = '20'; inputs[1].input(); check({ ...initialWeights, connectivity: 20 });
    assert.equal(sections[1].hidden, true);
    inputs[0].value = '-1'; inputs[0].input(); assert.equal(exportButton.disabled, true); assert.equal(scores.a.textContent, '—');
    reset.click(); assert.equal(exportButton.disabled, false); check(initialWeights);
  } finally { globalThis.document = originalDocument; }
});

test('preview matches EasyEDA Y-up view while keeping text upright and edge names consistent', () => {
  const body = y => ({ minX: -10, maxX: 10, minY: y - 10, maxY: y + 10 });
  const labels = [0, 100].map((y, i) => ({ text: ['J5', 'SW1'][i], fontSize: 10, rotation: i * 90, bbox: { minX: -10, maxX: 10, minY: y + 25, maxY: y + 35 } }));
  const components = [{ ref: 'J5', body: body(0) }, { ref: 'SW1', body: body(100) }];
  const candidate = { name: 'power', label: '功率连接优先', comparisonScore: 1, plan: { components, labels, bundles: components.map(c => ({ bbox: c.body })), counts: { moved: 0, rotated: 0, silkRelocated: 0 } }, validation: { valid: true, minimumGapMil: 8, edge: { details: [{ ref: 'SW1', side: 'bottom', satisfied: true }] } }, metrics: { groups: {}, details: [], displacementMil: 0, rotationFraction: 0, silkFraction: 0 } };
  const html = comparisonReport([candidate], candidate, { groups: [], comparisonWeights: {}, hard: { fixed: [] }, limits: [] }, { blocks: [{ id: 'b', components: ['J5', 'SW1'] }] }, { components, pads: [] });
  const texts = [...html.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>(J5|SW1)<\/text>/g)];
  const ys = Object.fromEntries(texts.map(m => [m[3], Number(m[2])]));
  assert.ok(ys.SW1 < ys.J5, 'positive PCB Y must appear above lower PCB Y');
  assert.equal(ys.SW1, -130);
  assert.match(html, /<rect x="-10" y="-110" width="20" height="20"/);
  assert.match(html, /viewBox="-80 -180 160 260"/);
  assert.match(html, /rotate\(-90 0 -130\)/);
  assert.match(html, /上 \/ Y最大/);
  assert.ok(!html.includes('scale(1,-1)') && !html.includes('scale(1 -1)'), 'do not mirror glyphs with an SVG group flip');
});
