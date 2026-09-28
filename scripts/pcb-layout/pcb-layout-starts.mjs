import { buildEdgeCandidate, inspectCandidate, initializeFeasibleLayout, validatePlan } from './pcb-layout-solver-core.mjs';
import { generateInitialProposals } from './pcb-layout-initial-proposals.mjs';

export function initializationOptions(input = {}, overrides = {}) {
  const allowed = ['schemaVersion', 'description', 'mode', 'count', 'seed', 'explorationStrength', 'packingGapMil', 'attemptsPerStart', 'maxRepairMil'];
  for (const value of [input, overrides]) if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw Error('INVALID_INITIALIZATION_OPTIONS');
  const o = { schemaVersion: 1, mode: 'existing', count: 1, seed: 92701, explorationStrength: .65, packingGapMil: 30, attemptsPerStart: 3, maxRepairMil: 100, ...input, ...overrides };
  if (o.schemaVersion !== 1 || !['existing', 'fresh', 'mixed'].includes(o.mode) || !Number.isInteger(o.count) || o.count < 1 || o.count > 32 || !Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff || !Number.isFinite(o.explorationStrength) || o.explorationStrength < 0 || o.explorationStrength > 1 || !Number.isFinite(o.packingGapMil) || o.packingGapMil < 0 || o.packingGapMil > 200 || !Number.isInteger(o.attemptsPerStart) || o.attemptsPerStart < 1 || o.attemptsPerStart > 8 || !Number.isFinite(o.maxRepairMil) || o.maxRepairMil < 0 || o.maxRepairMil > 2000 || (o.description !== undefined && typeof o.description !== 'string')) throw Error('INVALID_INITIALIZATION_OPTIONS');
  return o;
}

// Translation alone does not create another starting placement.
export function startPoseKey(plan) {
  const parts = [...plan.components].sort((a, b) => a.ref.localeCompare(b.ref));
  const minX = Math.min(...parts.map(c => c.x)), minY = Math.min(...parts.map(c => c.y));
  const quantize = value => Math.round((Math.round(value * 1e6) / 1e6) * 1000);
  return JSON.stringify(parts.map(c => [c.ref, quantize(c.x - minX), quantize(c.y - minY), quantize(((c.rotation % 360) + 360) % 360)]));
}

const rng = value => { let state = value >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296); };
function existingProposal(model, base, seed, strength) {
  const random = rng(seed), grid = model.config.search.gridMil;
  const groups = [...model.contract.blocks].sort((a, b) => a.id.localeCompare(b.id));
  const shifts = new Map();
  for (const group of groups) {
    const span = Math.sqrt(group.components.reduce((s, ref) => s + (model.referenceGeometry.get(ref)?.areaMil2 ?? 0), 0));
    const dx = Math.round((random() - .5) * strength * span / grid) * grid, dy = Math.round((random() - .5) * strength * span / grid) * grid;
    for (const ref of group.components) shifts.set(ref, { dx, dy });
  }
  const move = (c, ref, fixed) => { const d = fixed ? { dx: 0, dy: 0 } : shifts.get(ref) ?? { dx: 0, dy: 0 }; return { ...c, x: c.x + d.dx, y: c.y + d.dy }; };
  return { components: base.components.map(c => move(c, c.ref, model.fixed.has(c.ref))), testPads: base.testPads.map(p => move(p, p.number, model.pads.find(old => old.id === p.id)?.locked)), preferredEdges: {}, metadata: { mode: 'existing', seed, explorationStrength: strength } };
}

export function prepareLayoutStarts(model, overrides = {}, providedPlan = undefined, onProgress = () => {}) {
  const options = initializationOptions(model.config.initialization ?? {}, overrides);
  if (providedPlan && (providedPlan.sourceHash !== model.snapshot.sourceHash || !validatePlan(model, providedPlan).valid)) throw Error('INITIAL_PLAN_INVALID_FOR_CURRENT_INPUTS');
  if (providedPlan && options.mode === 'fresh') throw Error('INITIAL_PLAN_CONFLICTS_WITH_FRESH_MODE');
  const original = inspectCandidate(model).plan;
  const starts = [], attempts = [], keys = new Set();
  const keep = (candidate, metadata, attempt) => {
    const entry = { attempt, ...metadata, valid: candidate.validation.valid, issues: candidate.validation.issues.slice(0, 8) };
    if (candidate.validation.valid) {
      const key = startPoseKey(candidate.plan);
      if (keys.has(key)) entry.duplicate = true;
      else {
        keys.add(key); const id = 'start_' + String(starts.length + 1).padStart(3, '0');
        entry.startId = id;
        starts.push({ ...candidate, startId: id, initializationMetadata: { ...metadata, attempt } });
      }
    }
    attempts.push(entry); onProgress({ attempted: attempts.length, accepted: starts.length, requested: options.count, mode: metadata.mode, valid: entry.valid, duplicate: entry.duplicate ?? false, issues: entry.issues.slice(0, 3) });
  };
  if (options.mode !== 'fresh') {
    const initial = providedPlan ? buildEdgeCandidate(model, providedPlan.components, providedPlan, {}, {}, { maxRelocationMil: 0 }) : initializeFeasibleLayout(model, {}, { maxRelocationMil: options.maxRepairMil });
    keep(initial, { mode: 'existing', seed: options.seed, source: providedPlan ? 'verified-saved-plan' : 'original-input' }, 0);
  }
  const budget = options.count * options.attemptsPerStart;
  for (let i = 0; i < budget && starts.length < options.count; i++) {
    const seed = (options.seed + (i + 1) * 104729) >>> 0;
    const proposal = options.mode === 'existing' ? existingProposal(model, starts[0]?.plan ?? providedPlan ?? original, seed, options.explorationStrength) : generateInitialProposals(model, { seed: (options.seed + i * 104729) >>> 0, count: 1, explorationStrength: options.explorationStrength, packingGapMil: options.packingGapMil, gridMil: model.config.search.gridMil })[0];
    // Keep the original snapshot authoritative. Only the explicit prior TP
    // positions are substituted; labels are initialized from native identities.
    const prior = { ...(options.mode === 'existing' ? starts[0]?.plan ?? providedPlan ?? original : original), testPads: proposal.testPads };
    try {
      const candidate = buildEdgeCandidate(model, proposal.components, prior, {}, proposal.preferredEdges,
        { maxRelocationMil: options.maxRepairMil, initializeLabels: proposal.metadata.mode === 'fresh' });
      keep(candidate, proposal.metadata, i + 1);
    } catch (error) {
      attempts.push({ attempt: i + 1, ...proposal.metadata, valid: false, error: error.message });
      onProgress({ attempted: attempts.length, accepted: starts.length, requested: options.count, error: error.message });
    }
  }
  return { options, starts, attempts, requested: options.count, accepted: starts.length, exhausted: starts.length < options.count };
}

export function startingJobs(config, prepared, batch = 0) {
  return prepared.starts.flatMap((start, index) => config.search.profiles.map(profile => ({
    profile: { ...profile, name: profile.name + '_' + start.startId, label: profile.label + ' · 起点 ' + (index + 1), seed: (profile.seed + start.initializationMetadata.seed + batch * 104729) >>> 0 },
    baseProfile: profile.name, startId: start.startId, initialPlan: start.plan, initializationMetadata: start.initializationMetadata,
  })));
}

export async function runBoundedJobs(jobs, execute, limit = 4) {
  if (!Array.isArray(jobs) || typeof execute !== 'function' || !Number.isInteger(limit) || limit < 1) throw Error('INVALID_JOB_QUEUE');
  const results = new Array(jobs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await execute(jobs[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}
