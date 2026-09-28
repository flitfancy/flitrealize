import { transformBox, padOwner } from './pcb-layout-geometry.mjs';
import { initializeReport } from './pcb-layout-report-ui.mjs';
import { spacingOverlay, spacingDetails, spacingOverview } from './pcb-layout-spacing-report.mjs';
import { modelControls, modelOverlay, modelDetails, inputModelOverview, modelStyles } from './pcb-layout-model-report.mjs';
import { spacingPolicyOverview, spacingPolicyDetails } from './pcb-layout-spacing-policy-report.mjs';
function initializationOverview(input, candidates) {
  const references = input?.board?.scoreReferences;
  const starts = new Map(candidates.filter(c => c.initializationMetadata).map(c => [c.initializationMetadata.startId, c.initializationMetadata]));
  if (references?.mode !== 'geometry' && !starts.size) return '';
  const refs = references?.mode === 'geometry' ? '<p>评分参考由封装装配尺寸及网络拓扑计算，不以输入布局的距离归一化。原布局距离仅用于展示变化。</p><table><thead><tr><th>目标</th><th>固定参考 mm</th></tr></thead><tbody>' + Object.entries(references.groups).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+(v.mil*.0254).toFixed(3)+'</td></tr>').join('')+'</tbody></table>' : '';
  return '<div class="overview"><h2>起点与评分参考</h2>'+refs+(starts.size?'<p>本页包含 '+starts.size+' 个有效起点；各起点独立搜索。尚未进行结构聚类筛选。</p><table><thead><tr><th>起点</th><th>模式 / 种子</th><th>块顺序</th></tr></thead><tbody>'+[...starts].map(([id,m])=>'<tr><td>'+esc(id)+'</td><td>'+esc(m.mode)+' / '+m.seed+'</td><td>'+esc(m.blockOrder?.join(' → ')??'沿用输入')+'</td></tr>').join('')+'</tbody></table>':'')+'</div>';
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function reportRatio(candidate, key, distance) {
  const reference = candidate.metrics.scoreReferences?.groups?.[key]?.mil;
  if (!(Number.isFinite(reference) && reference > 0)) throw Error('REPORT_SCORE_REFERENCE_MISSING ' + key);
  return distance / reference;
}
export function comparisonReport(candidates, baseline, config, contract, snapshot, inputReceipt) {
  const ratioPolicy = baseline.metrics.spacingPolicy ?? null;
  const blockByRef = new Map(contract.blocks.flatMap((b, i) => b.components.map(ref => [ref, i])));
  const palette = ['#d9eafe', '#d7f0e7', '#f8e5d0', '#e4e0fb', '#f9e0eb'];
  const all = candidates.flatMap(c => [...c.plan.bundles.map(b => b.bbox), ...(c.metrics.spatial?.zones ?? []).map(z => z.box).filter(Boolean), ...(c.metrics.geometry?.assembly ?? []).map(s => s.bbox), ...(c.metrics.geometry?.operation ?? []).map(s => s.bbox)]);
  const x = Math.min(...all.map(b => b.minX)) - 70, y = Math.min(...all.map(b => b.minY)) - 70;
  const w = Math.max(...all.map(b => b.maxX)) - x + 70, h = Math.max(...all.map(b => b.maxY)) - y + 70;
  // Solver coordinates are Y-up; SVG is Y-down. Convert geometry at
  // rendering only, leaving solver coordinates and readable glyphs unchanged.
  const rectangle = (b, attrs) => '<rect x="' + b.minX + '" y="' + (-b.maxY) + '" width="' + (b.maxX - b.minX) + '" height="' + (b.maxY - b.minY) + '" ' + attrs + '/>';
  const rendered = candidates.map(candidate => {
    const p = candidate.plan;
    const spatial = candidate.metrics.spatial ?? { penalties: {}, relations: [], groups: [], zones: [] };
    let svg = '<svg viewBox="' + [x, -y - h, w, h].join(' ') + '" aria-label="布局几何示意，与 EDA 正常顶视图同向"><g class="layout-default">';
    if (candidate.validation.edge?.envelope) svg += rectangle(candidate.validation.edge.envelope, 'fill="none" stroke="#c08a40" stroke-dasharray="12 8" stroke-width="2"');
    for (const z of spatial.zones.filter(z => z.box)) svg += rectangle(z.box, 'fill="' + (z.mode === 'keepout' ? '#e05c5c' : '#60ac9f') + '" fill-opacity=".16" stroke="#486070" stroke-width="2" stroke-dasharray="8 5"');
    for (const c of p.components) svg += rectangle(c.body, 'fill="' + palette[blockByRef.get(c.ref) ?? 0] + '" stroke="#5b6678" stroke-width="1.7"');
    for (const pad of snapshot.pads) {
      const owner = padOwner(pad, snapshot.components), placed = owner && p.components.find(c => c.ref === owner.ref), tp = !owner && p.testPads.find(t => t.id === pad.id);
      const dx = owner ? placed.x - owner.x : tp.x - pad.x, dy = owner ? placed.y - owner.y : tp.y - pad.y;
      const b = owner ? transformBox(pad.bbox, owner, placed) : { minX: pad.bbox.minX + dx, maxX: pad.bbox.maxX + dx, minY: pad.bbox.minY + dy, maxY: pad.bbox.maxY + dy };
      svg += rectangle(b, 'fill="#b6862f" fill-opacity=".68"');
    }
    for (const l of p.labels) {
      const b = l.bbox, cx = (b.minX + b.maxX) / 2, cy = -(b.minY + b.maxY) / 2;
      svg += rectangle(b, 'fill="none" stroke="#5576a7" stroke-width=".6"') + '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" font-size="' + l.fontSize * .83 + '" transform="rotate(' + (-l.rotation) + ' ' + cx + ' ' + cy + ')" fill="#19345a">' + esc(l.text) + '</text>';
    }
    for (const g of spatial.groups) svg += '<g class="local-group"><title>' + esc(g.label + '：' + g.refs.join(', ')) + '</title>' + rectangle(g.box, 'fill="none" stroke="#0d9488" stroke-width="3" stroke-dasharray="10 5"') + '</g>';
    svg += spacingOverlay(spatial.uniformity) + '</g>' + modelOverlay(candidate) + '</svg>';
    const rows = Object.entries(candidate.metrics.groups).map(([id, g]) => {
      const old = baseline.metrics.groups[id].mil, pct = 100 * (g.mil / Math.max(1, old) - 1);
      return '<tr><td>' + esc(g.label) + '</td><td>' + (old * .0254).toFixed(2) + '</td><td>' + (g.mil * .0254).toFixed(2) + '</td><td class="' + (pct <= 0 ? 'good' : 'bad') + '">' + (pct > 0 ? '+' : '') + pct.toFixed(1) + '%</td></tr>';
    }).join('');
    const oldDetails = new Map(baseline.metrics.details.map(d => [d.id, d]));
    const differences = candidate.metrics.details.map(d => ({ ...d, old: oldDetails.get(d.id).mil, delta: d.mil - oldDetails.get(d.id).mil })).sort((a, b) => b.delta - a.delta);
    const regressions = differences.filter(d => d.delta > .01).slice(0, 8).map(d => '<li>' + esc(d.a + ' → ' + d.b + ' / ' + d.net) + '：+' + (d.delta * .0254).toFixed(2) + ' mm</li>').join('') || '<li>评价的局部连接没有变长。</li>';
    const sideNames = { left: '左 / X最小', right: '右 / X最大', top: '下 / Y最小', bottom: '上 / Y最大' };
    const featureRefs = [...new Set([...(candidate.validation.block?.details ?? []).map(b => b.ref), ...(candidate.validation.edge?.details ?? []).map(e => e.ref)])];
    const featureRows = featureRefs.map(ref => {
      const b = candidate.validation.block?.details.find(b => b.ref === ref), edge = candidate.validation.edge?.details.find(e => e.ref === ref);
      const blockId = contract.blocks.find(b => b.components.includes(ref))?.id ?? '未定义块';
      const fixed = config.hard.fixed?.some(c => c.ref === ref) || snapshot.components.find(c => c.ref === ref)?.locked;
      return '<tr><td>' + esc(ref + ' · ' + blockId) + (b?.anchors ? '<br><small>关联 ' + esc(b.anchors.join('、')) + '</small>' : '') + '</td><td>' + (edge ? esc(sideNames[edge.side] ?? '朝向无可用侧') + (edge.alignment ? '<br><small>' + (edge.alignment === 'long-side' ? '长边平行外缘' : '短边平行外缘') + '</small>' : '') + (edge.outwardLimited ? '<br><small>开口/操作面朝外</small>' : '') + (edge.satisfied ? ' ✓' : ' ×') : fixed ? '原位置锁定' : '未设贴边') + '</td><td>' + (b ? (b.distanceMil * .0254).toFixed(2) + ' / ' + (b.maxDistanceMil * .0254).toFixed(2) + (b.satisfied ? ' ✓' : ' ×') : '未设上限') + '</td></tr>';
    }).join('');
    const featureTable = featureRows ? '<h3>额外布局条件</h3><table><thead><tr><th>器件 / 所属块</th><th>自动选择的边</th><th>距关联中心 / 本轮上限（mm）</th></tr></thead><tbody>' + featureRows + '</tbody></table>' : '';
    const distanceRows = spatial.relations.map(r => '<tr><td>' + esc(r.a + ' → ' + r.anchors.join('/')) + '<br><small>' + esc(r.metric) + '</small></td><td>' + (r.distanceMil === null ? '待定义' : (r.distanceMil * .0254).toFixed(2)) + '</td><td>' + (r.band.idealMinMil === undefined ? '0' : (r.band.idealMinMil * .0254).toFixed(2)) + '–' + (r.band.idealMaxMil === undefined ? '∞' : (r.band.idealMaxMil * .0254).toFixed(2)) + '</td><td>' + r.penalty.toFixed(3) + '</td></tr>').join('');
    const spatialTable = '<h3>空间关系与区域检查</h3><p class="note">以下关系用于约束与观察；当前总分只计连接距离和间距均匀。</p><table><thead><tr><th>关系 / 测量方法</th><th>实际 mm</th><th>理想带 mm</th><th>未加权惩罚</th></tr></thead><tbody>' + distanceRows + '</tbody></table><p class="note">' + (spatial.zones.length ? spatial.zones.map(z => esc(z.id + ' / ' + z.mode) + '：占用 ' + (z.occupiedFraction === null ? '待定义' : (z.occupiedFraction * 100).toFixed(1) + '%')).join('；') : '本轮未指定留白/填充区域，区域项为 0。普通空白不奖不罚。') + '</p><details><summary>明确局部组（可重叠，不锁死内部器件）</summary><ul>' + spatial.groups.map(g => '<li>' + esc(g.label + '：' + g.refs.join('、')) + '</li>').join('') + '</ul></details>';
    const feasibility = candidate.validation.valid ? '<p class="good">' + '硬约束通过' + (candidate.nondominated ? ' · 展示候选中非支配' : '') + '</p>' : '<p class="bad">输入布局仅作对照，尚不满足新增条件：' + esc(candidate.validation.issues.map(i => (i.ref ?? i.id ?? i.refs?.join('/') ?? [i.a, i.b].filter(Boolean).join('/')) + ' ' + i.code).join('；')) + '。不参与可行候选排名。</p>';
    return '<section id="' + esc(candidate.name) + '" hidden><h2>' + esc(candidate.label) + '</h2>' + feasibility + (candidate.name !== 'baseline' && !p.counts.moved && !p.counts.rotated && !p.counts.silkRelocated && !p.counts.testPadsMoved ? '<p class="note">本轮未找到优于当前布局的结果，保留当前几何。</p>' : '') + '<p>统一比较分数 <b data-score="' + esc(candidate.name) + '">' + candidate.comparisonScore.toFixed(4) + '</b>（越低越好） · 平移 ' + p.counts.moved + ' 个 · 旋转 ' + p.counts.rotated + ' 个 · 位号相对位置变化 ' + p.counts.silkRelocated + ' 个 · 最小联合间距 ' + candidate.validation.minimumGapMil.toFixed(3) + ' mil</p>' + '<label class="group-toggle"><input type="checkbox" data-show-groups="' + esc(candidate.name) + '">显示局部组范围</label>' + modelControls(candidate) + svg + modelDetails(candidate) + spacingPolicyDetails(candidate.metrics.spacingPolicy) + (ratioPolicy ? '' : spacingDetails(spatial.uniformity, baseline.metrics.spatial?.uniformity, candidate.name)) + featureTable + spatialTable + '<table><thead><tr><th>代理指标合计</th><th>原布局 / mm</th><th>候选 / mm</th><th>变化</th></tr></thead><tbody>' + rows + '</tbody></table><h3>需要关注的局部退步</h3><ul>' + regressions + '</ul></section>';
  });
  const labels = { ...Object.fromEntries(config.groups.map(g => [g.id, g.label])), connectivity: '全板网络跨度', uniformity: '间距均匀', ...config.weightLabels };
  const controls = Object.entries(config.comparisonWeights).map(([key, value]) => '<label>' + esc(labels[key] ?? key) + '<input type="number" min="0" step="any" data-weight="' + esc(key) + '" value="' + value + '"></label>').join('');
  const data = { initialWeights: config.comparisonWeights, labels, groups: Object.keys(baseline.metrics.groups), candidates: candidates.map(c => ({ name: c.name, label: c.label, valid: c.validation.valid, ratios: Object.fromEntries(Object.entries(c.metrics.groups).map(([key, g]) => [key, reportRatio(c, key, g.mil)])), uniformity: c.metrics.spatial?.penalties.uniformity ?? 0 })) };
  const overview = '<div class="overview"><h2>分项比较</h2><p class="note">以下为加权贡献，越低越好；保留不同取舍的有限非支配采样结果，不代表全局最优。总分仅用于按当前偏好排序。</p><table><thead><tr><th>候选</th><th>电气</th><th>间距均匀</th><th>总分</th></tr></thead><tbody>' + candidates.map(c => '<tr><td>' + esc(c.label) + (c.nondominated ? ' ◇' : '') + '</td>' + ['electrical','spatial','value'].map(k => '<td data-breakdown="' + k + '" data-candidate="' + esc(c.name) + '">—</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  const encoded = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(contract.project?.title ?? 'PCB')} 布局候选与权重</title><style>
body{font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif;background:#f4f6f9;color:#243245;margin:0}main{max-width:1200px;margin:auto;padding:28px}h1{font-size:26px;margin:0}h2{font-size:20px}h3{font-size:16px}nav{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0}button{border:1px solid #c3cfdf;border-radius:8px;background:white;padding:10px 18px;color:#243245;cursor:pointer}button.active{background:#244f7e;color:white}button:disabled{opacity:.5;cursor:default}section,.weights,.overview{background:white;border-radius:14px;padding:22px;border:1px solid #e1e7ee}.controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:14px}label{display:flex;flex-direction:column;font-size:13px}input{margin-top:5px;padding:8px;border:1px solid #c3cfdf;border-radius:5px;font:inherit}svg{width:100%;max-height:650px;background:#fafcfe;border:1px solid #e5eaf1}table{width:100%;border-collapse:collapse;margin-top:18px}td,th{padding:9px;text-align:right;border-bottom:1px solid #e8ecf1}td:first-child,th:first-child{text-align:left}.good{color:#18754f}.bad{color:#b15127}.note{color:#637287;font-size:13px}code{overflow-wrap:anywhere}#weight-status{font-weight:600}.overview{margin-top:20px}.local-group{display:none}.show-groups .local-group{display:block}.group-toggle{display:flex;flex-direction:row;align-items:center;gap:8px}.group-toggle input{margin:0}small{color:#637287}
.spacing-overlay{display:none}.show-spacing .spacing-overlay{display:block}.spacing-bar{display:flex;height:14px;border-radius:5px;overflow:hidden}.spacing-details{border-top:1px solid #e1e7ee;margin-top:18px;padding-top:8px}${modelStyles}</style><main><h1>${esc(contract.project?.title ?? 'PCB')} · 布局候选与权重</h1><p>${config.reportMode === 'model-inspection' ? (config.reportSource === 'offline-snapshot' ? '模型检查模式：使用已保存的离线快照，不代表当前 EDA 现场；未运行布局搜索、未写入 PCB。' : '模型检查模式：展示本次只读现场快照；未运行布局搜索、未写入 PCB。') : '同一现场快照生成；全部候选尚未写入 PCB。'}器件按允许角度搜索，位号可选四侧。原生锁定及显式固定器件保持位置和角度，联合间距至少 ${inputReceipt?.board?.placementClearanceMil ?? baseline.plan.clearanceMil ?? "按输入规则"} mil。橙色虚线为器件占位包络，不是板框。贴边器件的侧别、朝向和关联距离条件见下表。大功能块只作逻辑分区，局部组可整体移动/旋转，组内仍可单独调整。</p>
${inputModelOverview(inputReceipt)}${initializationOverview(inputReceipt, candidates)}${spacingPolicyOverview(ratioPolicy)}<div class="weights"><h2>调整比较权重</h2><div class="controls">${controls}</div><p class="note">连接距离权重越大，越重视缩短该类连接；间距均匀权重控制相邻器件的间距偏好。0 表示不计该项。硬间距和固定位置不参与权衡。</p><p id="weight-status" aria-live="polite"></p><button id="reset-weights">恢复本轮权重</button> <button id="export-weights">导出权重 JSON</button><p class="note">这里仅对已有候选重算分数，图中的布局不会随输入改变。导出后，用这组权重重新求解才会生成新布局：</p><code>node &lt;skill&gt;/scripts/pcb-layout.mjs --project-root &lt;项目&gt; --mode solve --window-id &lt;当前窗口ID&gt; --weights-file &lt;导出的JSON路径&gt;</code></div>
${overview}${ratioPolicy ? '' : spacingOverview(candidates, config)}<nav>${candidates.map(c => '<button data-target="' + esc(c.name) + '">' + esc(c.label) + '</button>').join('')}</nav>${rendered.join('')}
<p class="note">色块按 Contract 功能分区；金色为旋转后的焊盘包围盒，位号为几何示意。位号相对位置变化不重复计入随器件平移、旋转的变化。搜索权重见 PCB_LAYOUT_WEIGHTS.v1.json。</p><p class="note">${(config.limits ?? []).map(esc).join('<br>')}</p></main><script>(${initializeReport.toString()})(${encoded})</script></html>`;
}
