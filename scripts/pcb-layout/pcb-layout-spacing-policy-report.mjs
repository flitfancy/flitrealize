const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = value => (value * 100).toFixed(0) + '%';
const mm = value => value === undefined ? '未另设' : value === null ? '待确定' : (value * .0254).toFixed(3) + ' mm';

export function spacingPolicyOverview(policy) {
  if (!policy) return '';
  if (policy.source !== 'assembly-courtyard' || policy.geometry !== 'physical') throw Error('UNSUPPORTED_SPACING_POLICY_REPORT');
  const b = policy.bandRatios, multiplier = n => Number((n / b.rejectBelow).toFixed(3));
  return '<div class="overview ratio-policy"><h2>封装派生间距规则 · 已启用</h2><p><strong>基础间距由封装装配边界计算。</strong>对每一对对象的每个分离方向，硬下限 H 取双方相对边的装配余量之和、绝对底线和明确成对要求中的最大值；比例基准 B = H / ' + b.rejectBelow + '。</p><table><thead><tr><th>实际物理净距 / B</th><th>处理</th></tr></thead><tbody><tr><td>低于 ' + pct(b.rejectBelow) + '</td><td>低于 H，拒绝；硬下限不打折</td></tr><tr><td>' + pct(b.rejectBelow) + ' 至 ' + pct(b.neutralMin) + '（不含后者）</td><td>偏近，计惩罚</td></tr><tr><td>' + pct(b.neutralMin) + ' 至 ' + pct(b.neutralMax) + '（含两端）</td><td>完全不扣分，相当于 ' + multiplier(b.neutralMin) + 'H～' + multiplier(b.neutralMax) + 'H</td></tr><tr><td>高于 ' + pct(b.neutralMax) + '</td><td>相邻器件偏远，计惩罚</td></tr></tbody></table><p class="note">物理净距使用器件原生包围盒与所属焊盘的并集代理；位号换边不会改变装配或比例测量。旋转后的四个分离方向分别计算，必须有同一方向同时满足装配边界与物理硬下限。基准 B 是保留比例区间的搜索换算，不是厂家推荐距离。</p><p class="note">当前绝对底线：' + (Number.isFinite(policy.absoluteFloorMil) ? policy.absoluteFloorMil + ' mil（' + mm(policy.absoluteFloorMil) + '）' : '见输入回执') + '。插拔、操作及散热要求仅在明确输入后检查。</p></div>';
}

export function spacingPolicyDetails(policy) {
  if (!policy) return '';
  if (policy.source !== 'assembly-courtyard' || policy.geometry !== 'physical') throw Error('UNSUPPORTED_SPACING_POLICY_REPORT');
  if (!policy.effective) return '';
  const rows = [...policy.neighbors].sort((a, b) => (b.penalty ?? 0) - (a.penalty ?? 0)).slice(0, 12).map(e => '<tr><td>' + esc(e.a + ' ↔ ' + e.b) + '</td><td>' + esc(e.axis) + '</td><td>' + mm(e.distanceMil) + '</td><td>' + mm(e.hardMinMil) + '</td><td>' + mm(e.baselineMil) + '</td><td>' + pct(e.ratio) + '</td><td>' + esc(({ neutral: '不扣分', tight: '偏近', loose: '偏远', 'below-minimum': '拒绝' })[e.status] ?? e.status) + '</td></tr>').join('');
  return '<div class="model-details"><h3>物理比例间距测量</h3><p>惩罚：' + (policy.penalty === null ? '硬条件未通过' : policy.penalty.toFixed(4)) + '；全部 ' + (policy.stats?.checkedPairs ?? 0) + ' 对对象检查硬下限。相邻器件参与间距评分，独立测试点仍参与硬检查。</p><p class="note">各方向比较净距与该方向的硬下限，采用满足程度最高的分离方向。表中 H 是硬下限，B = H / ' + policy.bandRatios.rejectBelow + '。位号不参与本表测量。</p><table><thead><tr><th>对象</th><th>方向</th><th>物理净距</th><th>硬下限 H</th><th>比例基准 B</th><th>比例</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}
