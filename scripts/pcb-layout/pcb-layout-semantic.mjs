// Confirmed circuit-block membership; no native writes.
// Group membership comes only from Contract.blocks.
import { hash } from './pcb-layout-project.mjs';

export function validateSemanticPolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw Error('INVALID_SEMANTIC_POLICY: expected an object');
  const retired = ['roles', 'associationWeights'].filter(key => Object.hasOwn(policy, key));
  if (policy.groupScope === 'relations') retired.push('groupScope: relations');
  if (retired.length) throw Error('RETIRED_SEMANTIC_POLICY: remove ' + retired.join(', ') + '; declare complete primary membership in Contract.blocks and explicit electrical relations in Contract.extensions.pcbLayout');
  const unknown = Object.keys(policy).filter(key => key !== 'groupScope');
  if (unknown.length) throw Error('UNKNOWN_SEMANTIC_POLICY_FIELD: ' + unknown.join(', '));
  if (Object.hasOwn(policy, 'groupScope') && policy.groupScope !== 'declared-block') throw Error('INVALID_SEMANTIC_GROUP_SCOPE: only declared-block is supported');
}

export function convertSemanticInputs(model, policy = model.config.semanticPolicy) {
  validateSemanticPolicy(policy);
  const refs = new Set([...model.components.keys(), ...model.pads.filter(p => !p.owner).map(p => p.number)]);
  const memberships = new Map([...refs].map(ref => [ref, []])), ids = new Set();
  const groups = model.contract.blocks.map(block => {
    if (!block.id || ids.has(block.id) || !Array.isArray(block.components)) throw Error('INVALID_SEMANTIC_BLOCK ' + block.id);
    ids.add(block.id);
    const members = block.components.filter(ref => refs.has(ref));
    for (const ref of members) memberships.get(ref).push(block.id);
    return { id: block.id, label: block.purpose || block.id, members, anchors: [], type: 'flexible', normalizedWeight: 0,
      sourceRules: [{kind:'confirmed-block-membership',source:'Contract.blocks/'+block.id}], existingLimitUnchanged:true };
  }).filter(g => g.members.length);
  for (const [ref, blocks] of memberships) if (blocks.length !== 1) throw Error('SEMANTIC_BLOCK_MEMBERSHIP_REQUIRED ' + ref + ': assign exactly one confirmed primary block; shared connections remain inter-block relations');
  const groupByRef = new Map(groups.flatMap(g => g.members.map(ref => [ref, g.id])));
  const interGroupEdges = model.contract.nets.map(net => ({net:net.name,kind:net.kind,groups:[...new Set(net.endpoints.map(e=>groupByRef.get(e.component)).filter(Boolean))],source:'Contract.nets/'+net.name})).filter(e=>e.groups.length>1);
  const boundaryLinks = (model.contract.extensions?.pcbLayout?.relations??[]).filter(r=>groupByRef.get(r.from.ref)!==groupByRef.get(r.to.ref)).map(r=>({kind:'cross-block-connection',refs:[r.from.ref,r.to.ref],relationKind:r.kind,net:r.net,source:'Contract.extensions.pcbLayout.relations/'+r.id}));
  return {schemaVersion:1,kind:'flitrealize.pcb-semantic-conversion',groups,interGroupEdges,boundaryLinks,inferredLinks:[],unresolvedRoles:[],sourceHash:model.snapshot.sourceHash,sourceRules:groups.flatMap(g=>g.sourceRules),
    policy:{groupScope:'declared-block',groups:'confirmed complete membership; flexible member poses; no group-span objective',roleHeuristics:'not-used',hardRules:'retained independently',initialization:'no source placement hints'},hash:hash({groups,interGroupEdges,boundaryLinks})};
}

// Observation only; the block stage does not score a second group envelope.
export function semanticGroupMetrics(semantic,plan){
  const boxes=new Map([...plan.components.map(p=>[p.ref,p.body]),...(plan.testPads??[]).map(p=>[p.number,p.bbox])]);
  return semantic.groups.map(group=>{const bs=group.members.map(ref=>boxes.get(ref));if(bs.some(b=>!b))throw Error('SEMANTIC_PLAN_MEMBERSHIP '+group.id);return {id:group.id,members:group.members,widthMil:Math.max(...bs.map(b=>b.maxX))-Math.min(...bs.map(b=>b.minX)),heightMil:Math.max(...bs.map(b=>b.maxY))-Math.min(...bs.map(b=>b.minY)),scored:false};});
}
