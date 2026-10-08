import { createHash } from 'node:crypto';

// One active-time budget is passed through scan, assignment, routing and repair.
// Offline pauses do not replenish the consumed budget and do not count as work.
export function createTaskBudget({ totalMs, consumedMs = 0, now = Date.now } = {}) {
  if (!Number.isFinite(totalMs) || totalMs <= 0 || !Number.isFinite(consumedMs) || consumedMs < 0) throw Error('INVALID_TASK_BUDGET');
  const started = now();
  const consumed = () => consumedMs + Math.max(0, now() - started);
  const remainingMs = () => Math.max(0, totalMs - consumed());
  return {
    remainingMs,
    assertRemaining() { if (remainingMs() <= 0) throw Error('TASK_BUDGET_EXHAUSTED'); },
    deadlineTimestampMs() { return now() + remainingMs(); },
    snapshot() { return { totalMs, consumedMs: Math.min(totalMs, consumed()) }; },
  };
}

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const routingFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// All effective options, geometry, rules, reservations and escape authorizations
// stay in the checkpoint; restore compares frozen inputs instead of reweighting.
export function createRoutingCheckpoint({ input, state, budget, attempts = [] }) {
  if (!input?.board || !input?.policy || !input?.options || !budget?.snapshot) throw Error('ROUTING_CHECKPOINT_INPUT_REQUIRED');
  return structuredClone({ schemaVersion: 1, input, inputFingerprint: routingFingerprint(input), state, budget: budget.snapshot(), attempts });
}
export function restoreRoutingCheckpoint(checkpoint, { input, now = Date.now } = {}) {
  if (checkpoint?.schemaVersion !== 1 || routingFingerprint(checkpoint.input) !== checkpoint.inputFingerprint || routingFingerprint(input) !== checkpoint.inputFingerprint) throw Error('ROUTING_CHECKPOINT_INPUT_CHANGED');
  return { input: structuredClone(checkpoint.input), state: structuredClone(checkpoint.state), attempts: structuredClone(checkpoint.attempts), budget: createTaskBudget({ ...checkpoint.budget, now }) };
}
