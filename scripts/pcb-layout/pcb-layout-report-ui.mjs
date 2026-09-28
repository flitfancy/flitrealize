// Embedded in the standalone report. Reweights existing candidates only.
export function initializeReport(data) {
  const inputs = [...document.querySelectorAll('[data-weight]')];
  const buttons = [...document.querySelectorAll('[data-target]')];
  const status = document.getElementById('weight-status');
  const exportButton = document.getElementById('export-weights');
  function show(id) {
    document.querySelectorAll('section').forEach(s => { s.hidden = s.id !== id; });
    buttons.forEach(b => b.classList.toggle('active', b.dataset.target === id));
  }
  function weights() {
    return Object.fromEntries(inputs.map(i => [i.dataset.weight, i.value.trim() ? Number(i.value) : NaN]));
  }
  function update() {
    const w = weights(), divisor = data.groups.reduce((sum, key) => sum + (w[key] ?? 0), 0);
    const invalid = Object.values(w).some(v => !Number.isFinite(v) || v < 0) || !Number.isFinite(Object.values(w).reduce((a, b) => a + b, 0)) || !(divisor > 0);
    exportButton.disabled = invalid;
    if (invalid) {
      status.textContent = '请输入非负有限数值；至少保留一个连接距离指标。';
      document.querySelectorAll('[data-score]').forEach(e => { e.textContent = '—'; });
      document.querySelectorAll('[data-breakdown]').forEach(e => { e.textContent = '—'; });
      return;
    }
    const ranked = data.candidates.map(c => {
      const electrical = data.groups.reduce((sum, key) => sum + (w[key] ?? 0) * c.ratios[key], 0) / divisor;
      const spatial = (w.uniformity ?? 0) * (c.uniformity ?? 0);
      return { ...c, electrical, spatial, value: electrical + spatial };
    }).sort((a, b) => a.value - b.value);
    for (const c of ranked) document.querySelector('[data-score="' + c.name + '"]').textContent = c.value.toFixed(4);
    document.querySelectorAll('[data-breakdown]').forEach(e => {
      const c = ranked.find(c => c.name === e.dataset.candidate);
      e.textContent = c[e.dataset.breakdown].toFixed(4);
    });
    status.textContent = '满足硬约束的候选排名：' + ranked.filter(c => c.valid !== false).map((c, i) => (i + 1) + '. ' + c.label + ' (' + c.value.toFixed(4) + ')').join(' → ');
  }
  buttons.forEach(b => b.addEventListener('click', () => show(b.dataset.target)));
  document.querySelectorAll('[data-show-groups]').forEach(e => e.addEventListener('change', () => {
    document.getElementById(e.dataset.showGroups).classList.toggle('show-groups', e.checked);
  }));
  document.querySelectorAll('[data-show-spacing]').forEach(e => e.addEventListener('change', () => {
    document.getElementById(e.dataset.showSpacing).classList.toggle('show-spacing', e.checked);
  }));
  document.querySelectorAll('[data-geometry-view]').forEach(e => e.addEventListener('change', () => {
    document.getElementById(e.dataset.geometryView).dataset.geometryMode = e.value;
  }));
  document.querySelectorAll('[data-show-coupling]').forEach(e => e.addEventListener('change', () => {
    document.getElementById(e.dataset.showCoupling).classList.toggle('show-coupling', e.checked);
  }));
  inputs.forEach(i => i.addEventListener('input', update));
  document.getElementById('reset-weights').addEventListener('click', () => { inputs.forEach(i => { i.value = String(data.initialWeights[i.dataset.weight]); }); update(); });
  exportButton.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, weights: weights(), labels: data.labels }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'PCB_LAYOUT_WEIGHTS.custom.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const requested = typeof location === 'undefined' ? '' : location.hash.slice(1);
  show(data.candidates.some(c => c.name === requested) ? requested : data.candidates[0].name); update();
}
