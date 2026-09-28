import test from 'node:test';
import assert from 'node:assert/strict';
import { labelTemplate } from '../scripts/pcb-layout/pcb-layout-label-policy.mjs';
test('label placement uses explicit footprint policy, independent of the reference name',()=>{
  const rules={labelTemplates:{footprints:[{names:['small-package'],anchor:'pads',minGapMil:10}]}};
  const a=labelTemplate({ref:'R_TEST',footprint:{name:'small-package'}},rules);
  const b=labelTemplate({ref:'IC_TEST',footprint:{name:'small-package'}},rules);
  assert.deepEqual(a,b);assert.equal(a.anchor,'pads');
  assert.equal(labelTemplate({ref:'R_TEST',footprint:{name:'other-package'}},rules).anchor,'body-and-pads');
});
test('ambiguous templates and misspelled spacing fields are errors',()=>{
  const c={ref:'PART',footprint:{name:'package'}};
  assert.throws(()=>labelTemplate(c,{labelTemplates:{default:{minGapMm:2}}}),/INVALID_LABEL_TEMPLATE/);
  assert.throws(()=>labelTemplate(c,{labelTemplates:{footprints:[{names:['package']},{names:['package']}]}}),/AMBIGUOUS_LABEL_TEMPLATE/);
});
