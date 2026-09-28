import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblyPolicyDetails, modelControls, modelOverlay, modelDetails, inputModelOverview } from '../scripts/pcb-layout/pcb-layout-model-report.mjs';
import { spacingPolicyOverview, spacingPolicyDetails } from '../scripts/pcb-layout/pcb-layout-spacing-policy-report.mjs';
import { catalogModel, catalogReport } from '../scripts/pcb-layout/pcb-layout-catalog-report.mjs';

const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
function fixture() {
  const policy = { schemaVersion: 2, mode: 'active', state: 'ready', source: 'assembly-courtyard', geometry: 'physical', effective: true,
    absoluteFloorMil: 8, bandRatios: { rejectBelow: .75, neutralMin: .9, neutralMax: 1.2 },
    penalty: 0, stats: { checkedPairs: 1 }, neighbors: [{ a: 'R1', b: 'R2', axis: 'y+', distanceMil: 24, hardMinMil: 20, baselineMil: 20 / .75, ratio: .9, penalty: 0, status: 'neutral' }] };
  const assembly = { profile: { id: 'reference', label: 'Test reference profile' }, source: { title: 'Reference', url: 'https://example.test' },
    coverage: { mappedComponents: 2, components: 2, uniqueFootprints: 1, independentPads: 1 }, valid: true, issues: [],
    records: ['R1', 'R2'].map(ref => ({ ref, ruleId: 'ordinary', footprint: 'TEST', marginMil: { xMinus: 10, xPlus: 10, yMinus: 10, yPlus: 10 }, courtyardLocal: null })) };
  const geometry = Object.fromEntries(['footprint', 'pads', 'physical', 'silkscreen', 'placement', 'assembly', 'operation'].map(k => [k, [{ ref: 'R1', bbox: box, source: 'proxy' }]]));
  geometry.assemblyPolicy = assembly;
  geometry.limitations = [{ code: 'RULE_DERIVED_ASSEMBLY' }];
  const candidate = { name: 'candidate_001', comparisonScore: 1, scores: { total: 1, electrical: 1, spacing: 0 },
    metrics: { geometry, assemblyPolicy: assembly, spacingPolicy: policy, groups: {}, coupling: { relations: [], crossBlockNets: [], ports: [] } },
    validation: { valid: true, issues: [], minimumGapMil: 8 },
    plan: { components: [{ ref: 'R1', x: 5, y: 5, rotation: 0, body: box }], labels: [], testPads: [], counts: {} } };
  const snapshot = { components: [{ id: 'r1', ref: 'R1', x: 5, y: 5, rotation: 0, bbox: box }], pads: [] };
  const config = { spacingPolicy: policy, assemblyRules: { profile: assembly.profile, source: assembly.source, rules: [{ id: 'ordinary', label: '普通器件', footprintNames: ['TEST'], marginMm: .254 }] } };
  return { policy, assembly, geometry, candidate, snapshot, config, contract: { blocks: [] } };
}

test('physical view is present only when measured, and assembly descriptions reflect generated courtyards', () => {
  const f = fixture();
  const controls = modelControls(f.candidate);
  assert.match(controls, /value="physical"/);
  assert.match(controls, /按规则生成的边界/);
  assert.doesNotMatch(controls, /装配封套和操作空间只显示明确提供/);
  assert.match(modelOverlay(f.candidate), /geometry-physical/);
  assert.match(modelDetails(f.candidate), /装配边界按封装规则生成/);
  delete f.geometry.physical; delete f.geometry.assemblyPolicy;
  assert.doesNotMatch(modelControls(f.candidate), /value="physical"/);
  assert.doesNotMatch(modelOverlay(f.candidate), /geometry-physical/);
  assert.match(modelControls(f.candidate), /装配封套和操作空间只显示明确提供/);
});

test('compiled assembly rules display source, coverage and actual data-derived margins', () => {
  const f = fixture(), html = assemblyPolicyDetails(f.assembly);
  assert.match(html, /Test reference profile/);
  assert.match(html, /覆盖 2 个器件、1 个独立测试焊盘/);
  assert.match(html, /每侧 0.254 mm/);
  assert.match(html, /R1、R2/);
  assert.match(html, /href="https:\/\/example.test"/);
  const input = { blocks: [], components: [], standalonePads: [], board: { assemblyPolicy: f.assembly } };
  assert.match(inputModelOverview(input), /每侧 0.254 mm/);
  f.assembly.source.url = 'javascript:alert(1)';
  f.assembly.profile.label = '<script>bad</script>';
  const escaped = assemblyPolicyDetails(f.assembly);
  assert.doesNotMatch(escaped, /href="javascript:|<script>/);
  assert.match(escaped, /&lt;script&gt;/);
});

test('derived ratio overview states hard-floor semantics and does not show legacy class/draft instructions', () => {
  const f = fixture(), html = spacingPolicyOverview(f.policy);
  assert.match(html, /B = H \/ 0.75/);
  assert.match(html, /1.2H～1.6H/);
  assert.match(html, /8 mil/);
  assert.match(html, /位号换边不会改变/);
  assert.doesNotMatch(html, /草稿|分类基准间距|填写完基准|不同类别之间取较大/);
  const detail = spacingPolicyDetails(f.policy);
  assert.match(detail, /物理比例间距测量/);
  assert.match(detail, /硬下限 H/);
  assert.match(detail, /y\+/);
  assert.match(detail, /0.508 mm/);
  const legacy = { mode: 'draft', state: 'pending', bandRatios: f.policy.bandRatios, classes: [], assignments: [] };
  assert.throws(() => spacingPolicyOverview(legacy), /UNSUPPORTED_SPACING_POLICY_REPORT/);
});

test('catalog describes supplied assembly geometry without provisional state placeholders', () => {
  const f = fixture();
  const model = catalogModel([f.candidate], f.candidate, f.config, f.contract, f.snapshot, { spacingPending: true, spacingProvisional: true });
  assert.equal(model.derivedSpacing, true);
  assert.equal(Object.hasOwn(model, 'spacingPending'), false);
  assert.equal(Object.hasOwn(model, 'spacingProvisional'), false);
  assert.equal(Object.hasOwn(model, 'spacingBasesMm'), false);
  assert.equal(model.assemblyProfile.rules[0].marginMm, .254);
  const html = catalogReport([f.candidate], f.candidate, f.config, f.contract, f.snapshot, { spacingPending: true, spacingProvisional: true });
  const visible = html.split('<script')[0];
  assert.match(visible, /装配档位：Test reference profile/);
  assert.match(visible, /普通器件：每侧 0.254 mm/);
  assert.match(visible, /1.2H～1.6H/);
  assert.match(visible, /8 mil 仅保留/);
  assert.doesNotMatch(visible, /本轮固定分类基准|按暂定分类间距试排|仅形态筛选/);
  const old = structuredClone(f.candidate); delete old.metrics.spacingPolicy; delete old.metrics.assemblyPolicy; delete old.metrics.geometry.assemblyPolicy;
  const declaredOnly = catalogModel([old], old, {}, f.contract, f.snapshot);
  assert.equal(declaredOnly.derivedSpacing, false);
  assert.equal(declaredOnly.assemblyProfile, null);
});
