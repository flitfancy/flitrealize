import { angle, transformBox } from './pcb-layout-geometry.mjs';
import { decodeEdgePose } from './pcb-layout-edge-domain.mjs';

const cardinal = value => angle(Math.round(value / 90) * 90);
export function parametersFromEdgePlan(model, plan, checked) {
  const positions = new Map(plan.components.map(c => [c.ref, c]));
  return new Map([...(model.edgeDomains ?? [])].map(([ref, domain]) => {
    const c = positions.get(ref), edge = checked.details.find(e => e.ref === ref);
    const state = domain.states.find(s => s.side === edge?.side && cardinal(s.rotation) === cardinal(c.rotation));
    if (!state) throw Error('CURRENT_EDGE_STATE_NOT_IN_DOMAIN ' + ref);
    return [ref, { state, alongMil: c[state.tangentAxis], insetMil: Math.min(domain.rule.maxInsetMil, Math.max(0, edge.insetMil ?? 0)) }];
  }));
}

// The envelope is a candidate variable, not a manufactured/fixed board outline.
// A caller may supply a coordinated smaller envelope for later contraction.
// Ordinary interior moves can enlarge the current candidate envelope here.
export function candidateEdgeEnvelope(model, current, proposed) {
  const original = new Map(current.components.map(c => [c.ref, c]));
  const boxes = proposed.map(c => model.edgeDomains?.has(c.ref) ? original.get(c.ref).body : transformBox(model.components.get(c.ref).bbox, model.components.get(c.ref), c));
  return { minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)), minY: Math.min(...boxes.map(b => b.minY)), maxY: Math.max(...boxes.map(b => b.maxY)) };
}

export function edgeAnchorOptions(model, ref, positions) {
  const rule = (model.blockRules ?? []).find(r => r.ref === ref);
  if (!rule) return {};
  const anchors = rule.anchors.map(r => positions.get(r));
  return { anchorCenter: { x: anchors.reduce((n,p)=>n+p.x,0)/anchors.length, y: anchors.reduce((n,p)=>n+p.y,0)/anchors.length }, maxDistanceMil: rule.maxDistanceMil };
}

export function constructEdgeLayout(model, proposed, parameters, envelope) {
  const positions = new Map(proposed.map(c => [c.ref, c]));
  const decoded = new Map(), issues = [], relocationAxesByRef = {}, preferredSides = {};
  for (const [ref, domain] of model.edgeDomains ?? []) {
    const parameter = parameters.get(ref);
    if (!parameter) throw Error('MISSING_EDGE_PARAMETERS ' + ref);
    const result = decodeEdgePose(domain, parameter.state, envelope, { alongMil: parameter.alongMil, insetMil: parameter.insetMil ?? 0, ...edgeAnchorOptions(model, ref, positions) });
    if (!result) { issues.push({ code:'EDGE_PARAMETER_DOMAIN_EMPTY', ref, side:parameter.state.side }); continue; }
    decoded.set(ref, result.pose);
    preferredSides[ref] = parameter.state.side;
    relocationAxesByRef[ref] = domain.fixed ? 'none' : parameter.state.tangentAxis;
  }
  return { valid: !issues.length, issues, positions: proposed.map(c => decoded.has(c.ref) ? { ...c, ...decoded.get(c.ref) } : { ...c }), relocationAxesByRef, preferredSides, generated: decoded.size };
}
