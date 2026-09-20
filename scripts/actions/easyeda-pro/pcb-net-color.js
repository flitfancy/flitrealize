// Color existing classes only; classification and membership belong to the upstream plan.
return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? {} : flitrealizeInput;
  const mode = request.mode ?? 'inspect';
  const palette = {
    power: '#D85C5C',
    ground: '#4E6FAE',
    logic_power: '#747985',
    logic: '#D69A52',
    logic_orange: '#D69A52',
    logic_green: '#648B65',
    logic_cyan: '#4C929B',
    switching: '#A568B5',
    analog: '#A08B4B',
    audio: '#C77996',
    i2c_scl: '#28745B',
    i2c_sda: '#4682B4',
    spi_sclk: '#A87924',
    spi_mosi: '#9C7BD8',
    spi_miso: '#8E4585',
    spi_cs: '#708238',
    uart_tx: '#D65A91',
    uart_rx: '#4B5BB5',
    reset: '#7B4545',
    interrupt: '#C2188B',
    enable: '#009B77',
    pwm: '#81728F',
    feedback: '#8B5A2B',
  };
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
  const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
  const validName = value => typeof value === 'string' && value.trim() && value === value.trim();
  const target = { expectedProjectUuid: request.expectedProjectUuid, expectedDocumentUuid: request.expectedDocumentUuid };
  if (request.plan) fail('OLD_REQUEST', 'Use a new plan or pass target and rules directly; old fingerprint plans are retired.');
  if (!['inspect', 'plan', 'apply'].includes(mode)) fail('INVALID_MODE', 'Use inspect, plan or apply; apply includes verification and optional save.');
  if (!Object.values(target).every(validName)) fail('TARGET_REQUIRED', 'Explicit project and PCB UUIDs are required.');

  async function assertTarget() {
    const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    const project = await eda.dmt_Project.getCurrentProjectInfo();
    if (Number(doc?.documentType) !== 3 || doc.uuid !== target.expectedDocumentUuid || project?.uuid !== target.expectedProjectUuid) {
      fail('TARGET_MISMATCH', 'Active project/PCB differs from the requested target.');
    }
  }
  async function readClasses() {
    const classes = await eda.pcb_Drc.getAllNetClasses();
    if (!Array.isArray(classes) || classes.some(c => !validName(c?.name) || !Array.isArray(c.nets) || c.nets.some(n => !validName(n))
      || new Set(c.nets).size !== c.nets.length || !['r', 'g', 'b'].every(k => Number.isInteger(c.color?.[k]) && c.color[k] >= 0 && c.color[k] <= 255)
      || !Number.isFinite(c.color?.alpha) || c.color.alpha < 0 || c.color.alpha > 1)
      || new Set(classes.map(c => c.name)).size !== classes.length) fail('CLASS_READ_FAILED', 'Invalid net class readback.');
    return classes.map(c => ({ name: c.name, nets: [...c.nets].sort(), color: c.color })).sort(byName);
  }
  async function readRules() {
    const config = await eda.pcb_Drc.getCurrentRuleConfiguration();
    const net = await eda.pcb_Drc.getNetRules();
    const pair = await eda.pcb_Drc.getNetByNetRules();
    const region = await eda.pcb_Drc.getRegionRules();
    if (!config?.config || !Array.isArray(net) || !pair || typeof pair !== 'object' || !Array.isArray(region)) {
      fail('RULE_READ_FAILED', 'Complete PCB rule readback is required.');
    }
    return JSON.parse(JSON.stringify({ config: config.config, net, pair, region }));
  }
  // Rule order can change after rebuilding a class; every rule field must survive.
  function netRules(value) {
    const key = rule => JSON.stringify([rule.type ?? '', rule.name ?? rule.net ?? '']);
    const compare = (a, b) => key(a).localeCompare(key(b));
    return value.map(rule => ({ ...rule,
      ...(Array.isArray(rule.sub) ? { sub: [...rule.sub].sort(compare) } : {}),
    })).sort(compare);
  }
  const sameRules = (a, b) => same({ ...a, net: netRules(a.net) }, { ...b, net: netRules(b.net) });
  async function write(method, ...args) {
    await assertTarget();
    if (await eda.pcb_Drc[method](...args) !== true) fail('CLASS_WRITE_FAILED', method + ' did not confirm success.');
    await assertTarget();
  }

  await assertTarget();
  const classes = await readClasses();
  await assertTarget();
  const display = { target, mechanism: 'net-class', visualVerified: false, perNetOverrides: 'not-modified-or-cleared' };
  if (mode === 'inspect') return { status: 'inspected', readOnly: true, ...display, classes, palette };
  if (!Array.isArray(request.rules) || !request.rules.length) fail('INVALID_RULES', 'Provide at least one class and its kind or color.');
  const selected = new Set();
  const assignments = request.rules.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('INVALID_RULES', 'Each rule must describe one net class.');
    if (Object.hasOwn(rule, 'color') && (typeof rule.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(rule.color))) fail('INVALID_COLOR', 'Class color must be #RRGGBB.');
    if (Object.hasOwn(rule, 'kind') && !validName(rule.kind)) fail('INVALID_KIND', 'Color kind must be a nonempty palette key.');
    const hex = rule.color ?? (Object.hasOwn(palette, rule.kind) ? palette[rule.kind] : null);
    if (!hex) fail('INVALID_COLOR', 'Provide a defined signal kind or #RRGGBB color.');
    const matches = classes.filter(c => rule.name !== undefined ? c.name === rule.name : Array.isArray(rule.nets) && same(c.nets, [...rule.nets].sort()));
    if (matches.length !== 1) fail('NET_CLASS_NOT_FOUND', 'Select one existing net class by name or complete membership.');
    const item = matches[0];
    if (rule.nets !== undefined && (!Array.isArray(rule.nets) || !same(item.nets, [...rule.nets].sort()))) fail('CLASS_MEMBERSHIP_MISMATCH', 'Members changed: ' + item.name);
    if (selected.has(item.name) || classes.some(c => c.name !== item.name && c.nets.some(n => item.nets.includes(n)))) fail('AMBIGUOUS_CLASS', 'Duplicate selection or overlapping classes: ' + item.name);
    selected.add(item.name);
    const color = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), alpha: 1 };
    return { ...item, color, hex: hex.toUpperCase() };
  });
  const changes = assignments.filter(item => !same(item.color, classes.find(c => c.name === item.name).color));
  if (mode === 'plan') return {
    status: 'planned', readOnly: true, ...display, assignments, changedCount: changes.length,
    applyRequest: { mode: 'apply', ...target, save: request.save === true,
      rules: assignments.map(c => ({ name: c.name, nets: c.nets, color: c.hex })) },
  };
  for (const method of ['deleteNetClass', 'createNetClass', 'overwriteCurrentRuleConfiguration', 'overwriteNetRules']) {
    if (typeof eda.pcb_Drc[method] !== 'function') fail('CAPABILITY_MISSING', 'Missing ' + method);
  }
  if (request.save === true && typeof eda.pcb_Document?.save !== 'function') fail('CAPABILITY_MISSING', 'Missing PCB save method.');
  const originalRules = await readRules();
  const before = { target, classes, rules: originalRules };
  let expected = classes, saved = false;
  const attempted = [];
  async function verify() {
    const actualClasses = await readClasses();
    const actualRules = await readRules();
    await assertTarget();
    if (!same(actualClasses, expected)) fail('COLOR_READBACK_MISMATCH', 'Class members/colors differ; readback alpha must be 1.');
    if (!sameRules(actualRules, originalRules)) fail('RULES_CHANGED', 'PCB rules differ from the original.');
  }
  try {
    await verify();
    for (const item of changes) {
      attempted.push(item.name);
      await write('deleteNetClass', item.name);
      if (!same(await readClasses(), expected.filter(c => c.name !== item.name))) fail('CLASS_DELETE_MISMATCH', 'Class deletion changed unexpected members.');
      await write('createNetClass', item.name, item.nets, { ...item.color, alpha: 255 });
      const current = await readRules();
      if (!same(current.pair, originalRules.pair) || !same(current.region, originalRules.region)) fail('RULES_CHANGED', 'Unexpected pair or region rule changes.');
      if (!same(current.config, originalRules.config)) await write('overwriteCurrentRuleConfiguration', originalRules.config);
      if (!same(netRules(current.net), netRules(originalRules.net))) await write('overwriteNetRules', originalRules.net);
      expected = expected.map(c => c.name === item.name ? { name: c.name, nets: c.nets, color: item.color } : c);
      await verify();
    }
    if (request.save === true) {
      await assertTarget();
      saved = null;
      if (await eda.pcb_Document.save() !== true) fail('SAVE_FAILED', 'Save did not confirm success; inspect the PCB before retrying.');
      saved = true;
      await verify();
    }
    return { status: 'applied', ...display, saved, changedCount: changes.length, assignments };
  } catch (error) {
    return { status: 'apply-failed', ...display, saved, before, attempted,
      error: { code: error.code ?? 'WRITE_FAILED', message: error.message } };
  }
})();
