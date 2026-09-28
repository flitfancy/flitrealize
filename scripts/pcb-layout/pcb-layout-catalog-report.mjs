const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const finite = (value, label) => { if (!Number.isFinite(value)) throw Error('CATALOG_INVALID_NUMBER: ' + label); return value; };
const packBox = (box, label) => ['minX', 'minY', 'maxX', 'maxY'].map(key => finite(box?.[key], label + '.' + key));
const scoreOf = candidate => finite(candidate.comparisonScore ?? candidate.scores?.total ?? candidate.scores?.value, candidate.name + '.score');

// The catalog deliberately carries only display inputs, not every measured
// geometry or search trace for every candidate. Source pad boxes are shared.
export function catalogModel(candidates, baseline, config, contract, snapshot, options = {}) {
  if (!Array.isArray(candidates) || !candidates.length) throw Error('CATALOG_EMPTY');
  const names = new Set();
  const blockByRef = new Map((contract.blocks ?? []).flatMap((block, index) => block.components.map(ref => [ref, index])));
  const sourceByRef = new Map((snapshot.components ?? []).map(component => [component.ref, component]));
  const sourceById = [...sourceByRef.values()];
  const footprints = Object.fromEntries([...sourceByRef].map(([ref, c]) => [ref, { pose: [c.x, c.y, c.rotation], pads: [] }]));
  for (const pad of snapshot.pads ?? []) {
    const owner = padOwner(pad, sourceById);
    if (owner) footprints[owner.ref].pads.push([...packBox(pad.bbox, pad.id), String(pad.number ?? ''), String(pad.net ?? '')]);
  }
  const baselineGroups = baseline?.metrics?.groups ?? {};
  const derivedSpacing = config.spacingPolicy?.source === 'assembly-courtyard' || baseline?.metrics?.spacingPolicy?.source === 'assembly-courtyard' || candidates.some(c => c.metrics?.spacingPolicy?.source === 'assembly-courtyard');
  const assembly = baseline?.metrics?.assemblyPolicy ?? baseline?.metrics?.geometry?.assemblyPolicy ?? candidates.find(c => c.metrics?.assemblyPolicy)?.metrics.assemblyPolicy;
  const spacingExample = baseline?.metrics?.spacingPolicy ?? candidates.find(c => c.metrics?.spacingPolicy)?.metrics.spacingPolicy;
  const assemblyProfile = derivedSpacing ? {
    profile: assembly?.profile ?? config.assemblyRules?.profile ?? null, source: assembly?.source ?? config.assemblyRules?.source ?? null,
    coverage: assembly?.coverage ?? null,
    absoluteFloorMil: spacingExample?.absoluteFloorMil ?? spacingExample?.neighbors?.flatMap(n => n.sources ?? []).find(s => s.type === 'absolute-floor')?.hardMinimumMil ?? null,
    bandRatios: config.spacingPolicy?.bandRatios ?? spacingExample?.bandRatios,
    rules: (config.assemblyRules?.rules ?? []).map(r => ({ id: r.id, label: r.label ?? r.id, marginMm: r.marginMm ?? null, trusted: r.courtyard?.trusted === true, footprintCount: r.footprintNames.length }))
  } : null;
  const sorted = candidates.map((candidate, inputIndex) => ({ candidate, inputIndex, score: scoreOf(candidate) })).sort((a, b) => a.score - b.score || a.inputIndex - b.inputIndex);
  const bounds = [];
  const packed = sorted.map(({ candidate, score }, index) => {
    const id = String(candidate.name ?? 'candidate-' + index);
    if (names.has(id)) throw Error('CATALOG_DUPLICATE_ID: ' + id);
    names.add(id);
    const components = candidate.plan.components.map(c => {
      if (!sourceByRef.has(c.ref)) throw Error('CATALOG_SOURCE_COMPONENT_MISSING: ' + c.ref);
      const box = packBox(c.body, c.ref); bounds.push(box);
      return [c.ref, finite(c.x, c.ref + '.x'), finite(c.y, c.ref + '.y'), finite(c.rotation, c.ref + '.rotation'), ...box, blockByRef.get(c.ref) ?? -1];
    });
    const labels = (candidate.plan.labels ?? []).map(label => {
      const box = packBox(label.bbox, label.id); bounds.push(box);
      return [String(label.text ?? ''), ...box, finite(label.fontSize, label.id + '.fontSize'), finite(label.rotation, label.id + '.rotation')];
    });
    const testPads = (candidate.plan.testPads ?? []).map(pad => { const box = packBox(pad.bbox, pad.id); bounds.push(box); return [...box, String(pad.number ?? pad.id), String(pad.net ?? '')]; });
    const envelope = candidate.validation?.edge?.envelope ? packBox(candidate.validation.edge.envelope, 'envelope') : null;
    const boardBounds = candidate.plan.boardBounds ? packBox(candidate.plan.boardBounds,'board') : null;
    if (boardBounds) bounds.push(boardBounds);
    if (envelope) bounds.push(envelope);
    const groups = Object.entries(candidate.metrics?.groups ?? {}).map(([key, value]) => ({ key, label: value.label ?? key, mil: finite(value.mil, key), baselineMil: Number.isFinite(baselineGroups[key]?.mil) ? baselineGroups[key].mil : null }));
    const issues = (candidate.validation?.issues ?? []).map(issue => ({ code: issue.code ?? 'UNKNOWN', object: issue.ref ?? issue.id ?? issue.refs?.join(', ') ?? '' }));
    const policy = candidate.metrics?.spacingPolicy;
    return { id, number: index + 1, label: String(candidate.label ?? id), initializationMetadata: candidate.initializationMetadata ?? null, score, components, labels, testPads, envelope, boardBounds, groups,
      valid: candidate.validation?.valid === true, issues,
      edgeDirections: (candidate.validation?.edge?.details ?? []).filter(e => e.alignment || e.outwardLimited).map(e => ({ ref: e.ref, side: e.side, alignment: e.alignment ?? null, outward: !!e.outwardLimited, satisfied: e.satisfied })),
      minGapMil: Number.isFinite(candidate.validation?.minimumGapMil) ? candidate.validation.minimumGapMil : null,
      counts: candidate.plan.counts ?? {},
      spacing: policy ? { mode: policy.mode, state: policy.state, penalty: policy.penalty ?? null, checkedPairs: policy.stats?.checkedPairs ?? null } : null,
      scores: Object.fromEntries(Object.entries(candidate.scores ?? {}).filter(([key, value]) => Number.isFinite(value))) };
  });
  if (!bounds.length) throw Error('CATALOG_NO_GEOMETRY');
  const minX = Math.min(...bounds.map(b => b[0])), minY = Math.min(...bounds.map(b => b[1]));
  const maxX = Math.max(...bounds.map(b => b[2])), maxY = Math.max(...bounds.map(b => b[3]));
  const margin = Math.max(30, Math.max(maxX - minX, maxY - minY) * .035);
  return { schemaVersion: 1, runId: String(options.runId ?? 'layout-catalog'), sourceLabel: String(options.sourceLabel ?? '本次布局快照'),
    derivedSpacing, assemblyProfile,
    pageSize: 20, viewBox: [minX - margin, -maxY - margin, Math.max(1, maxX - minX) + 2 * margin, Math.max(1, maxY - minY) + 2 * margin],
    scoreReferences: baseline?.metrics?.scoreReferences ?? null, blocks: (contract.blocks ?? []).map(block => ({ id: block.id, label: block.label ?? block.name ?? block.id })),
    scoreLabels: { ...(config.weightLabels ?? {}), ...(options.scoreLabels ?? {}) }, footprints, candidates: packed };
}

// Self-contained so the same renderer is tested in Node and embedded in file://
// reports. Native Y-up coordinates are converted for SVG only, never mirrored.
export function renderCatalogSvg(candidate, model, detailed = true) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(6));
  const rectangle = (box, attributes) => '<rect x="' + number(box[0]) + '" y="' + number(-box[3]) + '" width="' + number(box[2] - box[0]) + '" height="' + number(box[3] - box[1]) + '" ' + attributes + '/>';
  const palette = ['#d9eafe', '#d7f0e7', '#f8e5d0', '#e4e0fb', '#f9e0eb'];
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc((detailed ? '详细布局 ' : '布局缩略图 ') + candidate.number) + '，EDA 顶视图 Y 轴向上" viewBox="' + model.viewBox.map(number).join(' ') + '" preserveAspectRatio="xMidYMid meet">';
  if (candidate.boardBounds) svg += rectangle(candidate.boardBounds, 'class="board-outline" fill="none" stroke="#16706c" stroke-width="3"');
  else if (candidate.envelope) svg += rectangle(candidate.envelope, 'fill="none" stroke="#c08a40" stroke-dasharray="12 8" stroke-width="2"');
  for (const c of candidate.components) svg += '<g><title>' + esc(c[0]) + '</title>' + rectangle(c.slice(4, 8), 'fill="' + (c[8] < 0 ? '#e6ebf0' : palette[c[8] % palette.length]) + '" stroke="#718096" stroke-width="' + (detailed ? '1.7' : '3') + '"') + '</g>';
  if (detailed) {
    for (const c of candidate.components) {
      const footprint = model.footprints[c[0]], from = footprint.pose;
      const rawQuarter = (c[3] - from[2]) / 90, quarter = Math.round(rawQuarter);
      if (Math.abs(rawQuarter - quarter) > 1e-6) throw Error('CATALOG_NON_ORTHOGONAL_ROTATION: ' + c[0]);
      const q = ((quarter % 4) + 4) % 4;
      for (const pad of footprint.pads) {
        const corners = [[pad[0], pad[1]], [pad[0], pad[3]], [pad[2], pad[1]], [pad[2], pad[3]]].map(([x, y]) => {
          x -= from[0]; y -= from[1];
          const rotated = [[x, y], [-y, x], [-x, -y], [y, -x]][q];
          return [c[1] + rotated[0], c[2] + rotated[1]];
        });
        const box = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
        svg += '<g><title>' + esc(c[0] + '.' + pad[4] + ' · ' + pad[5]) + '</title>' + rectangle(box, 'fill="#b6862f" fill-opacity=".73"') + '</g>';
      }
    }
    for (const pad of candidate.testPads) svg += '<g><title>' + esc(pad[4] + ' · ' + pad[5]) + '</title>' + rectangle(pad, 'fill="#b6862f" fill-opacity=".73"') + '</g>';
    for (const label of candidate.labels) {
      const box = label.slice(1, 5), cx = number((box[0] + box[2]) / 2), cy = number(-(box[1] + box[3]) / 2);
      svg += rectangle(box, 'fill="none" stroke="#5576a7" stroke-width=".6"') + '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" font-size="' + number(label[5] * .83) + '" transform="rotate(' + number(-label[6]) + ' ' + cx + ' ' + cy + ')" fill="#19345a">' + esc(label[0]) + '</text>';
    }
  }
  return svg + '</svg>';
}

function initializeCatalog(model, renderSvg) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const id = value => document.getElementById(value);
  const statusLabels = { like: '喜欢', review: '待看', reject: '拒绝' };
  const storageKey = 'flitrealize-layout-feedback:' + model.runId;
  const byId = new Map(model.candidates.map(c => [c.id, c]));
  let feedback = {}, storageError = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    for (const c of model.candidates) {
      const value = saved[c.id];
      if (value && typeof value === 'object') feedback[c.id] = { status: Object.hasOwn(statusLabels, value.status) ? value.status : null, note: typeof value.note === 'string' ? value.note.slice(0, 600) : '', updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null };
    }
  } catch { storageError = true; }
  let page = 0, filter = 'all', selected = model.candidates[0].id;
  try { const hash = decodeURIComponent(location.hash.slice(1)); if (byId.has(hash)) selected = hash; } catch { /* Keep the first candidate for malformed hashes. */ }
  const filtered = () => model.candidates.filter(c => filter === 'all' || (filter === 'unmarked' ? !feedback[c.id]?.status : feedback[c.id]?.status === filter));
  const format = value => Number.isFinite(value) ? value.toFixed(3) : '—';
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(feedback)); storageError = false; } catch { storageError = true; }
    id('storage-status').textContent = storageError ? '浏览器未保存标记；请导出 JSON 留存。当前页面内仍可继续筛选。' : '标记仅保存在本浏览器本地，不改变布局和分数。';
  }
  function renderCount() {
    const totals = { like: 0, review: 0, reject: 0 };
    for (const value of Object.values(feedback)) if (Object.hasOwn(totals, value.status)) totals[value.status]++;
    id('feedback-count').textContent = '已标记 ' + Object.values(totals).reduce((a, b) => a + b, 0) + ' / ' + model.candidates.length + ' · 喜欢 ' + totals.like + ' · 待看 ' + totals.review + ' · 拒绝 ' + totals.reject;
  }
  function renderGrid() {
    const list = filtered(), pages = Math.max(1, Math.ceil(list.length / model.pageSize));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = list.slice(page * model.pageSize, (page + 1) * model.pageSize);
    id('catalog-grid').innerHTML = slice.map(c => '<button type="button" class="card' + (c.id === selected ? ' selected' : '') + '" data-candidate="' + esc(c.id) + '"><span class="card-heading"><strong>#' + String(c.number).padStart(3, '0') + '</strong><span>' + c.score.toFixed(4) + '</span></span>' + renderSvg(c, model, false) + '<span class="card-footer"><span>' + esc(c.label) + '</span><span class="badge ' + esc(feedback[c.id]?.status ?? '') + '">' + esc(statusLabels[feedback[c.id]?.status] ?? '未标记') + '</span></span></button>').join('') || '<p class="empty">此筛选下还没有候选。</p>';
    id('page-status').textContent = '第 ' + (page + 1) + ' / ' + pages + ' 页 · ' + list.length + ' 组';
    id('previous-page').disabled = page === 0; id('next-page').disabled = page >= pages - 1;
    renderCount();
  }
  function renderDetails() {
    const c = byId.get(selected), value = feedback[selected] ?? {}, list = filtered(), index = list.findIndex(row => row.id === selected);
    id('detail-title').textContent = '#' + String(c.number).padStart(3, '0') + ' · ' + c.label;
    id('detail-score').textContent = '排序分数 ' + c.score.toFixed(4) + '（越低越好）' + (c.initializationMetadata ? ' · ' + c.initializationMetadata.startId + ' / ' + c.initializationMetadata.mode + ' / 种子 ' + c.initializationMetadata.seed : '');
    id('detail-svg').innerHTML = renderSvg(c, model, true);
    id('selected-position').textContent = index < 0 ? '当前大图已不在筛选结果中' : '筛选中第 ' + (index + 1) + ' / ' + list.length + ' 组';
    id('previous-candidate').disabled = index <= 0; id('next-candidate').disabled = index < 0 || index >= list.length - 1;
    id('candidate-note').value = value.note ?? '';
    document.querySelectorAll('[data-mark]').forEach(button => { const active = button.dataset.mark === value.status; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    const conditional = model.derivedSpacing ? '封装装配参考规则与物理比例间距；位号另做防撞' : '仅对应已配置的条件';
    const status = c.valid ? '已定义的几何硬条件：通过' : '已定义的几何硬条件：未通过';
    const gap = c.minGapMil === null ? '' : ' · 最小联合占位间隙 ' + format(c.minGapMil) + ' mil（' + format(c.minGapMil * .0254) + ' mm）';
    id('hard-status').textContent = status + '；' + conditional + gap;
    id('hard-status').className = c.valid ? 'status' : 'status problem';
    id('hard-issues').textContent = c.issues.map(issue => issue.object + ' ' + issue.code).join('；');
    const sideNames = { left:'左',right:'右',top:'下',bottom:'上' };
    id('edge-orientation').textContent = (c.edgeDirections ?? []).map(e => e.ref + '：' + (e.alignment ? (e.alignment === 'long-side' ? '长边' : '短边') + '沿' + sideNames[e.side] + '侧' : '') + (e.outward ? (e.alignment ? '，' : '') + '开口/操作面朝' + sideNames[e.side] : '') + (e.satisfied ? ' ✓' : ' ×')).join('；');
    id('distance-body').innerHTML = c.groups.map(group => {
      const delta = group.baselineMil > 0 ? (group.mil / group.baselineMil - 1) * 100 : null;
      return '<tr><td>' + esc(group.label) + '</td><td>' + format(group.baselineMil === null ? null : group.baselineMil * .0254) + '</td><td>' + format(group.mil * .0254) + '</td><td>' + (delta === null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(1) + '%') + '</td></tr>';
    }).join('');
    const scoreNames = { electrical: '指定连接距离', spacing: model.derivedSpacing ? '物理间距惩罚' : '分类间距惩罚', spatial: '比例间距', stability: '改动项', total: '总分', value: '总分', ...model.scoreLabels };
    id('score-breakdown').textContent = Object.entries(c.scores).map(([key, number]) => (scoreNames[key] ?? key) + ' ' + number.toFixed(4)).join(' · ');
    id('change-counts').textContent = '器件平移 ' + (c.counts.moved ?? '—') + ' · 旋转 ' + (c.counts.rotated ?? '—') + ' · 位号相对位置变化 ' + (c.counts.silkRelocated ?? '—');
  }
  function choose(candidateId, followPage = true) {
    if (!byId.has(candidateId)) return;
    selected = candidateId;
    const index = filtered().findIndex(c => c.id === selected);
    if (followPage && index >= 0) page = Math.floor(index / model.pageSize);
    try { history.replaceState(null, '', '#' + encodeURIComponent(selected)); } catch { /* Navigation still works without history support. */ }
    renderGrid(); renderDetails();
  }
  id('catalog-grid').addEventListener('click', event => { const target = event.target.closest('[data-candidate]'); if (target) choose(target.dataset.candidate, false); });
  id('catalog-filter').addEventListener('change', event => { filter = event.target.value; page = 0; const list = filtered(); if (list.length && !list.some(c => c.id === selected)) selected = list[0].id; renderGrid(); renderDetails(); });
  id('previous-page').addEventListener('click', () => { page--; renderGrid(); });
  id('next-page').addEventListener('click', () => { page++; renderGrid(); });
  for (const [element, delta] of [['previous-candidate', -1], ['next-candidate', 1]]) id(element).addEventListener('click', () => { const list = filtered(), index = list.findIndex(c => c.id === selected), next = list[index + delta]; if (next) choose(next.id); });
  document.querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', () => {
    feedback[selected] = { ...(feedback[selected] ?? { note: '' }), status: button.dataset.mark === 'clear' ? null : button.dataset.mark, updatedAt: new Date().toISOString() };
    persist(); renderGrid(); renderDetails();
  }));
  id('candidate-note').addEventListener('input', event => { feedback[selected] = { ...(feedback[selected] ?? { status: null }), note: event.target.value.slice(0, 600), updatedAt: new Date().toISOString() }; persist(); renderCount(); });
  id('export-feedback').addEventListener('click', () => {
    const result = { schemaVersion: 1, runId: model.runId, sourceLabel: model.sourceLabel, exportedAt: new Date().toISOString(), derivedSpacing: model.derivedSpacing, assemblyProfile: model.assemblyProfile,
      candidates: model.candidates.map(c => ({ id: c.id, number: c.number, label: c.label, score: c.score, status: feedback[c.id]?.status ?? null, note: feedback[c.id]?.note ?? '', updatedAt: feedback[c.id]?.updatedAt ?? null })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'layout-feedback-' + model.runId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    id('export-status').textContent = '已请求下载本地反馈 JSON；没有向外发送数据。';
  });
  id('storage-status').textContent = storageError ? '无法读取本地标记；可继续筛选并导出 JSON。' : '标记仅保存在本浏览器本地，不改变布局和分数。';
  choose(selected);
}

export function catalogReport(candidates, baseline, config, contract, snapshot, options = {}) {
  const model = catalogModel(candidates, baseline, config, contract, snapshot, options);
  const encoded = JSON.stringify(model).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const disclaimer = model.derivedSpacing ? '使用封装装配参考规则与物理比例间距；几何为包围盒代理，尚非生产或电气验收。' : '仅比较当前已定义规则下的候选，不代表完整装配或电气验收。';
  let assemblyNotice = '';
  if (model.assemblyProfile) {
    const a = model.assemblyProfile, c = a.coverage ?? {}, band = a.bandRatios;
    const margins = a.rules.map(r => r.label + '：' + (typeof r.marginMm === 'number' ? '每侧 ' + r.marginMm + ' mm' : r.marginMm ? Object.entries(r.marginMm).map(([k, v]) => k + ' ' + v + ' mm').join('、') : '可信边界，不再次外扩')).join('；');
    assemblyNotice = '<p class="muted assembly-profile">装配档位：' + escapeHtml(a.profile?.label ?? a.profile?.id ?? '见输入回执') + '；覆盖 ' + (c.mappedComponents ?? c.components ?? '—') + ' 个器件、' + (c.independentPads ?? '—') + ' 个独立测试焊盘、' + (c.uniqueFootprints ?? '—') + ' 种封装。' + escapeHtml(margins) + '。</p><p class="muted">基础几何为本体与焊盘并集的原生包围盒代理；位号不影响装配或比例测距。每对、每个分离方向计算硬下限 H，B = H / ' + band.rejectBelow + '；' + (band.rejectBelow * 100).toFixed(0) + '% 对应 H，' + (band.neutralMin * 100).toFixed(0) + '%～' + (band.neutralMax * 100).toFixed(0) + '% 不扣分，即 ' + Number((band.neutralMin / band.rejectBelow).toFixed(3)) + 'H～' + Number((band.neutralMax / band.rejectBelow).toFixed(3)) + 'H。' + (a.absoluteFloorMil === null ? '机械绝对底线见输入回执' : a.absoluteFloorMil + ' mil 仅保留为机械联合占位防撞和绝对底线') + '；比例换算是搜索偏好，不是厂家推荐值。</p>';
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PCB · 布局候选筛选</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#243348;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1600px;margin:auto;padding:26px}h1{font-size:27px;margin:0}h2{font-size:20px;margin:0}p{margin:10px 0}button,select,textarea{font:inherit;color:inherit}button,select{border:1px solid #bdcad9;border-radius:7px;background:white;padding:8px 13px}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #4c8dce;outline-offset:2px}.notice{background:#fff3d9;border:1px solid #dfbb68;color:#745012;border-radius:9px;padding:12px 16px;font-weight:650}.muted{color:#65758a;font-size:13px}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:17px 0}.toolbar .grow{flex:1}.layout{display:grid;grid-template-columns:minmax(410px,.95fr) minmax(530px,1.35fr);gap:20px;align-items:start}.catalog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{padding:9px;text-align:left;background:#fff;border:1px solid #d4dfe9;min-width:0}.card.selected{border:2px solid #285b8f;padding:8px;box-shadow:0 0 0 2px #dceafa}.card-heading,.card-footer{display:flex;justify-content:space-between;gap:7px;align-items:center}.card-heading{font-size:13px}.card-footer{font-size:12px;line-height:1.4;margin-top:6px}.card-footer>span:first-child{overflow-wrap:anywhere}.card svg{width:100%;height:150px;display:block;background:#f8fafc}.badge{flex-shrink:0;color:#6e7c8d;padding:2px 5px;border-radius:4px;background:#edf1f6}.badge.like{background:#e3f2e8;color:#25643d}.badge.reject{background:#f9e6e3;color:#993e36}.badge.review{background:#fff2d9;color:#8b640e}.detail{background:#fff;border:1px solid #d4dfe9;border-radius:12px;padding:20px;position:sticky;top:14px;max-height:calc(100vh - 28px);overflow:auto}.detail svg{display:block;width:100%;height:auto;max-height:66vh;min-height:280px;background:#fafcfe;border:1px solid #e1e8ef}.detail-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.detail-nav span{margin-left:auto;font-size:12px;color:#68788c}.marks{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 9px}.marks button.active{background:#285b8f;color:#fff;border-color:#285b8f}textarea{display:block;width:100%;resize:vertical;min-height:65px;max-height:200px;padding:9px;border:1px solid #c4d0dd;border-radius:6px}.status{font-size:13px;color:#3b6b59}.problem{color:#a8432d}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:7px 4px;border-bottom:1px solid #e7edf3;text-align:right}td:first-child,th:first-child{text-align:left}summary{cursor:pointer;margin:12px 0}.pager{display:flex;justify-content:space-between;gap:10px;align-items:center;margin:14px 0;font-size:13px}.empty{grid-column:1/-1;padding:25px}.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}.swatch{display:inline-block;width:12px;height:12px;margin-right:5px;border:1px solid #9eacbd}.storage{margin:20px 0 0}@media(min-width:1400px){.catalog-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.layout{grid-template-columns:minmax(620px,1fr) minmax(600px,1.1fr)}}@media(max-width:1000px){main{padding:15px}.layout{grid-template-columns:1fr}.detail{position:static;max-height:none;grid-row:1}.catalog-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.detail svg{max-height:70vh}}@media(max-width:600px){.catalog-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.detail{padding:12px}.card svg{height:120px}}
</style></head><body><main><h1>PCB · ${model.candidates.length} 组布局候选</h1><p>${escapeHtml(model.sourceLabel)} · 按本轮现有分数升序排列，编号固定。候选尚未写入 PCB。</p><p class="notice">${escapeHtml(disclaimer)}</p>${assemblyNotice}<p class="muted">形态由实际候选坐标绘制；全页采用共同尺度与 EDA 顶视图方向，保持纵横比例和空白。缩略图只显示封装占位，大图显示真实变换后的焊盘与位号。橙色虚线是占位包络，不是板框；图中几何仍是包围盒代理。</p><div class="toolbar"><label>筛选 <select id="catalog-filter"><option value="all">全部</option><option value="like">喜欢</option><option value="review">待看</option><option value="reject">拒绝</option><option value="unmarked">未标记</option></select></label><span id="feedback-count" class="grow" aria-live="polite"></span><button id="export-feedback" type="button">导出反馈 JSON</button></div><div class="layout"><div><div class="pager"><button id="previous-page" type="button">上一页</button><span id="page-status"></span><button id="next-page" type="button">下一页</button></div><div id="catalog-grid" class="catalog-grid"></div></div><section class="detail" aria-label="选中候选详情"><div class="detail-nav"><button id="previous-candidate" type="button">上一组</button><button id="next-candidate" type="button">下一组</button><span id="selected-position"></span></div><h2 id="detail-title"></h2><p id="detail-score"></p><p id="hard-status"></p><p id="hard-issues" class="problem"></p><p id="edge-orientation" class="muted"></p><div id="detail-svg"></div><div class="marks"><button type="button" data-mark="like" aria-pressed="false">喜欢</button><button type="button" data-mark="review" aria-pressed="false">待看</button><button type="button" data-mark="reject" aria-pressed="false">拒绝</button><button type="button" data-mark="clear">清除标记</button></div><label for="candidate-note">简短备注</label><textarea id="candidate-note" maxlength="600" placeholder="例如：这一组接口位置合适；某局部区域仍然拥挤。"></textarea><p id="change-counts" class="muted"></p><details open><summary>分项距离与评分</summary><p id="score-breakdown" class="muted"></p><p class="muted">距离是脚本现有代理指标，单位 mm；不等于实际走线长度。</p><table><thead><tr><th>指标</th><th>输入布局</th><th>本组</th><th>变化</th></tr></thead><tbody id="distance-body"></tbody></table></details></section></div><p id="storage-status" class="muted storage"></p><p id="export-status" class="muted" aria-live="polite"></p><p class="muted">本地筛选反馈独立于布局评分。喜欢、待看、拒绝及备注不会移动器件，也不会修改求解结果。</p></main><script id="catalog-data" type="application/json">${encoded}</script><script>(${initializeCatalog.toString()})(JSON.parse(document.getElementById('catalog-data').textContent), ${renderCatalogSvg.toString()});</script></body></html>`;
}
import { padOwner } from './pcb-layout-geometry.mjs';
