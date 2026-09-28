const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = { footprint: '封装占位', pads: '焊盘', physical: '本体与焊盘代理', silkscreen: '位号', placement: '器件＋位号', assembly: '装配边界', operation: '操作空间' };
const colors = { footprint: '#416ca2', pads: '#b77912', physical: '#176c86', silkscreen: '#764bb4', placement: '#487d6b', assembly: '#b34f87', operation: '#db643a' };
const limitText = {
  NATIVE_BBOX_PROXY: '封装占位是原生包围盒代理，不是精确实体或装配边界',
  BOUNDS_ONLY: '当前只计算二维轴对齐包围盒，未建立孔槽、精确铜形状或三维体积',
  QUARTER_TURN_NATIVE_TRANSFORMS: '原生几何按相对直角旋转；显式封套可跟随绝对角度变换',
  EXPLICIT_ENVELOPES_ONLY: '装配与操作空间只采用明确输入的封套；空白表示未定义',
  RULE_DERIVED_ASSEMBLY: '装配边界按封装规则生成，或采用明确提供的可信边界；本体与焊盘仍是原生包围盒代理。操作空间需要单独尺寸',
  LAYER_METADATA_ONLY: '层信息缺失时保留未知；当前区域检查尚不按铜层区分',
  NATIVE_LABELS_ONLY: '位号视图仅包括输入中的原生文字，不代表完整丝印图形',
};
const rect = b => 'x="' + b.minX + '" y="' + (-b.maxY) + '" width="' + (b.maxX - b.minX) + '" height="' + (b.maxY - b.minY) + '"';
const availableViews = g => Object.entries(names).filter(([key]) => Array.isArray(g[key]));
const millimetres = n => Number((n * .0254).toFixed(3)).toString();

export function assemblyPolicyDetails(policy) {
  if (!policy) return '';
  const coverage = policy.coverage ?? {}, grouped = new Map();
  for (const r of policy.records ?? []) {
    const key = JSON.stringify([r.ruleId, r.marginMil, r.courtyardLocal, r.overrideBasis]);
    if (!grouped.has(key)) grouped.set(key, { ...r, refs: [], footprints: new Set() });
    const group = grouped.get(key); group.refs.push(r.ref); group.footprints.add(r.footprint);
  }
  const rows = [...grouped.values()].map(g => {
    const margin = g.marginMil ? (new Set(Object.values(g.marginMil)).size === 1 ? '每侧 ' + millimetres(g.marginMil.xMinus) + ' mm' : Object.entries(g.marginMil).map(([axis, n]) => axis + ' ' + millimetres(n) + ' mm').join('；')) : '采用可信边界，不再次外扩';
    return '<tr><td>' + esc(g.ruleId) + (g.overrideBasis ? '<br><small>器件例外：' + esc(g.overrideBasis) + '</small>' : '') + '</td><td>' + esc(margin) + '</td><td>' + g.footprints.size + '</td><td>' + g.refs.length + '</td><td><details><summary>查看覆盖器件</summary>' + esc(g.refs.join('、')) + '</details></td></tr>';
  }).join('');
  const source = /^https?:\/\//.test(policy.source?.url ?? '') ? '<a href="' + esc(policy.source.url) + '">' + esc(policy.source.title ?? policy.source.url) + '</a>' : esc(policy.source?.title ?? '来源未提供');
  return '<div class="assembly-policy-details"><h3>封装装配规则 · ' + esc(policy.profile?.label ?? policy.profile?.id) + '</h3><p>覆盖 ' + (coverage.mappedComponents ?? coverage.components ?? '—') + ' 个器件、' + (coverage.independentPads ?? '—') + ' 个独立测试焊盘；' + (coverage.uniqueFootprints ?? '—') + ' 种封装。参考来源：' + source + '。</p><p class="note">由器件原生包围盒与所属焊盘的并集形成物理占位代理，位号不参与装配边界或比例测距。单侧余量随器件旋转；相对两侧余量相加，可信装配边界不重复外扩。测试焊盘不增加装配余量，实际焊盘仍作为障碍。该参考档位不代表已验证实体外形、手焊返修、插拔操作或生产验收。</p>' + (rows ? '<table><thead><tr><th>规则</th><th>单侧余量</th><th>封装种类</th><th>器件数</th><th>覆盖</th></tr></thead><tbody>' + rows + '</tbody></table>' : '') + '</div>';
}

export function modelControls(candidate) {
  const g = candidate.metrics?.geometry;
  if (!g) return '';
  const note = g.assemblyPolicy ? '物理占位由本体与焊盘的原生包围盒代理组成；装配边界包含按规则生成的边界和明确提供的封套。位号另做防撞，操作空间仍只显示明确输入的尺寸。' : '封装与焊盘均为包围盒代理；装配封套和操作空间只显示明确提供的尺寸。图上无此类形状表示未定义，不表示检查通过。';
  return '<div class="model-controls"><label>几何用途<select data-geometry-view="' + esc(candidate.name) + '"><option value="normal">布局总览</option>' + availableViews(g).map(([key, name]) => '<option value="' + key + '">' + name + '（' + g[key].length + '）</option>').join('') + '</select></label><label class="group-toggle"><input type="checkbox" data-show-coupling="' + esc(candidate.name) + '">显示已声明的跨块关系</label></div><p class="note">' + note + '关系连线表示端点关系，不是实际走线。</p>';
}

export function modelOverlay(candidate) {
  const g = candidate.metrics?.geometry;
  if (!g) return '';
  let result = availableViews(g).map(([key]) => '<g class="geometry-view geometry-' + key + '">' + g[key].map(s => '<g><title>' + esc(s.ref + (s.number ? '.' + s.number : '') + ' ' + (s.net ?? '') + ' / ' + s.source) + '</title><rect ' + rect(s.bbox) + ' fill="' + colors[key] + '" fill-opacity=".18" stroke="' + colors[key] + '" stroke-width="2"/><text x="' + (s.bbox.minX + s.bbox.maxX) / 2 + '" y="' + (-(s.bbox.minY + s.bbox.maxY) / 2) + '" dominant-baseline="central" text-anchor="middle" font-size="14" fill="#25354b">' + esc(s.ref + (key === 'pads' ? '.' + s.number : '')) + '</text></g>').join('') + '</g>').join('');
  result += '<g class="coupling-overlay">' + (candidate.metrics.coupling?.relations ?? []).filter(r => r.endpoints?.length === 2).map(r => '<g><title>' + esc(r.id + ' / ' + r.net + ' / ' + r.distanceMil.toFixed(2) + ' mil') + '</title><line x1="' + r.endpoints[0].x + '" y1="' + (-r.endpoints[0].y) + '" x2="' + r.endpoints[1].x + '" y2="' + (-r.endpoints[1].y) + '" stroke="#dc4966" stroke-width="5" stroke-dasharray="9 4"/>' + r.endpoints.map(p => '<circle cx="' + p.x + '" cy="' + (-p.y) + '" r="5" fill="#dc4966"/>').join('') + '</g>').join('') + '</g>';
  return result;
}

export function modelDetails(candidate) {
  const coupling = candidate.metrics?.coupling, g = candidate.metrics?.geometry;
  if (!coupling || !g) return '';
  const relations = coupling.relations.map(r => '<tr><td>' + esc(r.from.ref + '.' + r.from.pin + ' → ' + r.to.ref + '.' + r.to.pin) + '<br><small>' + esc(r.fromBlock + ' → ' + r.toBlock) + '</small></td><td>' + esc(r.net) + '</td><td>' + (r.distanceMil * .0254).toFixed(3) + '</td><td>' + (r.maxDistanceMil === undefined || r.maxDistanceMil === null ? '仅观察' : '≤' + (r.maxDistanceMil * .0254).toFixed(3) + ' mm / ' + (r.satisfied ? '通过' : '未通过')) + '</td></tr>').join('');
  const nets = coupling.crossBlockNets.map(n => '<tr><td>' + esc(n.net) + '</td><td>' + esc(n.kind ?? '') + '</td><td>' + esc(n.blocks.join('、')) + '</td></tr>').join('');
  return '<div class="model-details"><h3>块间关系</h3><p class="note">网络与端口从 Contract 和实际焊盘核对生成。共享地或总线保留为连接多个块的同一网络，不推断方向、不增加两两吸引分数。显式声明的关系测量指定引脚；只有输入了最大距离才启用该硬限制。本轮布局质量由你判断。</p><table><thead><tr><th>端点 / 功能块</th><th>网络</th><th>端点距离 mm</th><th>检查方式</th></tr></thead><tbody>' + relations + '</tbody></table><details><summary>查看 ' + coupling.crossBlockNets.length + ' 条跨块网络与 ' + coupling.ports.length + ' 个块端口</summary><table><thead><tr><th>网络</th><th>类型</th><th>涉及的块</th></tr></thead><tbody>' + nets + '</tbody></table></details><h3>几何模型范围</h3><p>' + availableViews(g).map(([key, label]) => esc(label) + '：' + g[key].length).join('；') + '。</p><p class="note">' + g.limitations.map(l => esc(typeof l === 'string' ? l : limitText[l.code] ?? l.message ?? l.code)).join('；') + '</p>' + assemblyPolicyDetails(g.assemblyPolicy) + '</div>';
}

export function inputModelOverview(input) {
  if (!input) return '';
  const rows = input.blocks.map(b => '<tr><td>' + esc(b.id) + '</td><td>' + esc(b.purpose) + '</td><td>' + b.members.length + '</td><td>' + b.ports.length + '</td></tr>').join('');
  return '<div class="overview input-overview"><h2>三级输入与跨块关系</h2><p>整板规则 → ' + input.blocks.length + ' 个功能块 → ' + input.components.length + ' 个器件与 ' + input.standalonePads.length + ' 个独立测试焊盘。局部组和跨块关系通过引用连接，成员身份保持不变。</p><table><thead><tr><th>功能块</th><th>作用</th><th>成员数</th><th>跨块端口数</th></tr></thead><tbody>' + rows + '</tbody></table><p class="note">layout-input.json 是从原有配置和快照生成的输入回执。器件作用已保留为说明文字；通用“作用→规则模板”编译尚未实现。跨块关系是否成为硬限制取决于明确输入的距离要求。</p>' + assemblyPolicyDetails(input.board?.assemblyPolicy) + '</div>';
}

export const modelStyles = '.model-controls{display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin:16px 0}.model-controls select{padding:8px;border:1px solid #c3cfdf;border-radius:6px;background:white}.geometry-view,.coupling-overlay{display:none}.show-coupling .coupling-overlay{display:block}.model-details{margin-top:20px}section[data-geometry-mode]:not([data-geometry-mode="normal"]) .layout-default{display:none}' + Object.keys(names).map(k => 'section[data-geometry-mode="' + k + '"] .geometry-' + k + '{display:block}').join('');
