const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = v => v === null || v === undefined ? '—' : v.toFixed(1);
const percent = v => v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%';
const colors = { tight: '#c94d52', inBand: '#279777', loose: '#bd7c19' };

export function spacingOverlay(u) {
  if (!u) return '';
  return '<g class="spacing-overlay">' + u.edges.map(e => '<g><title>' + esc(e.a + ' ↔ ' + e.b + '：' + number(e.distanceMil) + ' mil' + (e.kind === 'bridge' ? '（斜向连接）' : '')) + '</title><line x1="' + e.from.x + '" y1="' + (-e.from.y) + '" x2="' + e.to.x + '" y2="' + (-e.to.y) + '" stroke="' + colors[e.status] + '" stroke-width="3"' + (e.kind === 'bridge' ? ' stroke-dasharray="6 4"' : '') + '/></g>').join('') + '</g>';
}

export function spacingDetails(u, before, name) {
  if (!u) return '';
  const stats = u.stats, old = before?.stats;
  const rows = [...u.edges].sort((a, b) => b.penalty - a.penalty).slice(0, 10).map(e => '<tr><td>' + esc(e.a + ' ↔ ' + e.b) + (e.kind === 'bridge' ? ' · 斜向' : '') + '</td><td>' + number(e.distanceMil) + '</td><td>' + (e.status === 'tight' ? '偏挤' : e.status === 'loose' ? '偏松' : '容差内') + '</td></tr>').join('');
  const counts = [['tight', '偏挤'], ['inBand', '容差内'], ['loose', '偏松']];
  const bars = counts.map(([key, label]) => '<span style="width:' + (stats.pairs ? stats[key] / stats.pairs * 100 : 0) + '%;background:' + colors[key] + '" title="' + label + ' ' + stats[key] + ' 对"></span>').join('');
  return '<div class="spacing-details"><h3>相邻间距均匀度</h3><p>目标 <b>' + u.targetMil + ' mil</b>，容差 <b>±' + u.toleranceMil + ' mil</b>（' + ((u.targetMil - u.toleranceMil) * .0254).toFixed(3) + '–' + ((u.targetMil + u.toleranceMil) * .0254).toFixed(3) + ' mm）。全局 8 mil 硬下限独立保留。</p><p>均匀度惩罚 <b>' + u.penalty.toFixed(4) + '</b>（原布局 ' + (before ? before.penalty.toFixed(4) : '—') + '，越低越好）；容差内占比 <b>' + percent(stats.inBandFraction) + '</b>（原布局 ' + percent(old?.inBandFraction) + '）。</p><div class="spacing-bar">' + bars + '</div><p class="note">红：偏挤 ' + stats.tight + ' 对 · 绿：容差内 ' + stats.inBand + ' 对 · 橙：偏松 ' + stats.loose + ' 对。相邻关系随布局重算，共 ' + stats.pairs + ' 对；斜向补连 ' + stats.bridges + ' 对。中位数 ' + number(stats.medianMil) + ' mil，P10–P90 ' + number(stats.p10Mil) + '–' + number(stats.p90Mil) + ' mil，标准差 ' + number(stats.stddevMil) + ' mil。</p><label class="group-toggle"><input type="checkbox" data-show-spacing="' + esc(name) + '">在上图标出相邻间距（悬停查看数值）</label><details><summary>偏差较大的相邻位置</summary><table><thead><tr><th>相邻器件</th><th>间距 mil</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></details><p class="note">量器件＋位号占位的边缘间隙。沿四边找可见邻居；若第三颗器件离两端都更近，排除这条远距关系。孤立组间补最短边缘连接（虚线，斜向用欧氏间隙）；没有距离截断。独立测试焊盘只参与原有机械碰撞检查，不参与均匀度。容差内仍轻微趋向目标，带外惩罚平滑增强；每个器件先取邻边惩罚平均，再全板平均。上面的分布统计仅展示，不重复加入总分。</p></div>';
}

export function spacingOverview(candidates, config) {
  if (!candidates.some(c => c.metrics.spatial?.uniformity)) return '';
  const rows = candidates.map(c => {
    const u = c.metrics.spatial?.uniformity;
    return '<tr><td>' + esc(c.label) + '</td><td>' + (u?.penalty.toFixed(4) ?? '—') + '</td><td>' + percent(u?.stats.inBandFraction) + '</td><td>' + number(u?.stats.p10Mil) + '–' + number(u?.stats.p90Mil) + '</td><td>' + number(u?.stats.stddevMil) + '</td></tr>';
  }).join('');
  const u = config.spatial.uniformity;
  return '<div class="overview"><h2>间距分布比较</h2><p class="note">每个候选按自身相邻关系统计；配合上方电气变化选择。这里是原始指标，调权重不会改变这些几何测量。</p><table><thead><tr><th>候选</th><th>均匀度惩罚 ↓</th><th>容差内占比 ↑</th><th>P10–P90 / mil</th><th>标准差 / mil</th></tr></thead><tbody>' + rows + '</tbody></table><p class="note">目标间距、容差可在 PCB_LAYOUT_SPATIAL.v1.json 的 uniformity 中调整；强度由上方“相邻间距均匀”权重控制。用新参数生成布局：</p><code>node scripts/pcb-layout-solve.mjs --window-id &lt;当前窗口ID&gt; --spacing-target-mil ' + u.targetMil + ' --spacing-tolerance-mil ' + u.toleranceMil + ' --weight uniformity=' + (config.comparisonWeights.uniformity ?? 0) + '</code></div>';
}
