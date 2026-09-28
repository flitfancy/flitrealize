import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEdgeRules, checkEdges } from '../scripts/pcb-layout/pcb-layout-edge.mjs';
import { compileEdgeDomains, decodeEdgePose } from '../scripts/pcb-layout/pcb-layout-edge-domain.mjs';
import { constructEdgeLayout, candidateEdgeEnvelope, parametersFromEdgePlan } from '../scripts/pcb-layout/pcb-layout-edge-construction.mjs';
import { transformBox } from '../scripts/pcb-layout/pcb-layout-geometry.mjs';

function fixture() {
  const c={ref:'J5',x:0,y:0,rotation:0,bbox:{minX:-40,maxX:40,minY:-10,maxY:10}};
  const core={ref:'U1',x:0,y:0,rotation:0,bbox:{minX:-100,maxX:100,minY:-100,maxY:100}};
  const components=new Map([[c.ref,c],[core.ref,core]]),allowed=new Map([['J5',[0,90,180,270]],['U1',[0]]]);
  const edgeRules=compileEdgeRules([{ref:'J5',alignment:'long-side'}],components);
  return {components,edgeRules,edgeDomains:compileEdgeDomains(edgeRules,components,allowed),blockRules:[],fixed:new Map()};
}
const bodies=(m,ps)=>ps.map(p=>({...p,body:transformBox(m.components.get(p.ref).bbox,m.components.get(p.ref),p)}));

test('every generated legal edge state satisfies alignment and contact before any mechanical repair',()=>{
  const m=fixture(),domain=m.edgeDomains.get('J5'),frame={minX:-100,maxX:100,minY:-100,maxY:100};
  const source=[...m.components.values()];
  let count=0;
  for(const state of domain.states) for(const alongMil of [-500,-20,0,60,500]){
    const built=constructEdgeLayout(m,source,new Map([['J5',{state,alongMil}]]),frame);
    assert.ok(built.valid);assert.equal(checkEdges(m.edgeRules,bodies(m,built.positions)).issues.length,0);
    assert.equal(built.relocationAxesByRef.J5,state.tangentAxis);
    assert.equal(built.positions[0][state.normalAxis],frame[state.normalKey]-state.bodyOffset[state.normalKey]);count++;
  }
  assert.equal(count,40);assert.deepEqual(source,[...m.components.values()]);
});

test('dynamic anchor conflict is identified before constructing a candidate for mechanical evaluation',()=>{
  const m=fixture(),domain=m.edgeDomains.get('J5'),state=domain.states.find(s=>s.side==='top');
  m.blockRules=[{ref:'J5',anchors:['U1'],maxDistanceMil:1}];
  const built=constructEdgeLayout(m,[...m.components.values()],new Map([['J5',{state,alongMil:0}]]),{minX:-100,maxX:100,minY:-100,maxY:100});
  assert.equal(built.valid,false);assert.equal(built.issues[0].code,'EDGE_PARAMETER_DOMAIN_EMPTY');
});

test('parameter roundtrip removes the independent normal-coordinate variable',()=>{
  const m=fixture(),domain=m.edgeDomains.get('J5'),state=domain.states.find(s=>s.side==='top'&&s.rotation===0);
  const pose=decodeEdgePose(domain,state,{minX:-100,maxX:100,minY:-100,maxY:100},{alongMil:20}).pose;
  const plan={components:bodies(m,[pose,m.components.get('U1')])};
  const parameters=parametersFromEdgePlan(m,plan,checkEdges(m.edgeRules,plan.components));
  const proposed=plan.components.map(p=>({...p,...(p.ref==='J5'?{y:9999}:{})}));
  const envelope=candidateEdgeEnvelope(m,plan,proposed);
  const rebuilt=constructEdgeLayout(m,proposed,parameters,envelope);
  assert.equal(rebuilt.positions.find(p=>p.ref==='J5').y,pose.y);
  parameters.get('J5').alongMil+=25;
  assert.equal(constructEdgeLayout(m,proposed,parameters,envelope).positions.find(p=>p.ref==='J5').x,45);
  assert.throws(()=>decodeEdgePose(domain,state,envelope,{x:20}),/EDGE_DOMAIN_INVALID_PARAMETERS/);
});
