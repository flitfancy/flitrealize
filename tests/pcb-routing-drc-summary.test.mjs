import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeNativeDrc} from '../scripts/providers/easyeda-pro/drc-summary.mjs';

test('native grouped DRC counts every physical leaf, not group or declared count',()=>{
 const result=summarizeNativeDrc([
  {name:'Connection Error',count:2,list:[{name:'GND',list:[{errorType:'Connection Error'},{errorType:'No Connection'}]}]},
  {name:'Netlist Error',count:1,list:[{name:'Netlist Error',list:[{ruleName:'Import Changes'}]}]},
  {name:'Clearance Error',count:1,list:[{name:'Common',list:[{errorType:'Clearance Error'},{errorType:'Clearance Error'}]}]},
 ]);
 assert.deepEqual(result,{physicalErrorCount:2,connectionErrorCount:2,netlistErrorCount:1,totalErrorCount:5});
});
test('unknown and contradictory leaf categories remain physical errors',()=>{
 const result=summarizeNativeDrc([{name:'new-category'},{name:'Connection Error',list:[{errorType:'Clearance Error'}]}]);
 assert.equal(result.physicalErrorCount,2);assert.equal(result.connectionErrorCount,0);
});
test('empty reports and empty zero-count groups have no errors',()=>{
 assert.equal(summarizeNativeDrc([]).totalErrorCount,0);
 assert.equal(summarizeNativeDrc([{name:'Clearance Error',count:0,list:[]}]).totalErrorCount,0);
});
test('malformed or incomplete verbose results cannot pass as clean',()=>{
 for(const value of [true,null,[null],[{list:null}],[{list:[],count:3}]])assert.throws(()=>summarizeNativeDrc(value),/DRC_/);
});
