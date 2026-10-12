import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const fail = (code, detail = '') => { throw Object.assign(Error(code + (detail ? ': ' + detail : '')), { code }); };
export const finiteBox = b => b && ['minX','maxX','minY','maxY'].every(k => Number.isFinite(b[k])) && b.minX < b.maxX && b.minY < b.maxY;
export const within = (b, a, tolerance = 1e-4) => b.minX >= a.minX-tolerance && b.maxX <= a.maxX+tolerance && b.minY >= a.minY-tolerance && b.maxY <= a.maxY+tolerance;
export const union = boxes => ({minX:Math.min(...boxes.map(b=>b.minX)),maxX:Math.max(...boxes.map(b=>b.maxX)),minY:Math.min(...boxes.map(b=>b.minY)),maxY:Math.max(...boxes.map(b=>b.maxY))});
export const near = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= 1e-4;
export const samePose = (a,b) => a && b && ['x','y','rotation'].every(k=>near(a[k],b[k]));
export const sameBox = (a,b) => a && b && ['minX','maxX','minY','maxY'].every(k=>near(a[k],b[k]));
export const issueRefs = i => [...new Set([...(i.refs??[]),...[i.ref,i.owner,i.a,i.b].filter(v=>typeof v==='string')])];
const stableIssue=value=>typeof value==='number'?Math.round(value*10000)/10000:Array.isArray(value)?value.map(stableIssue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,stableIssue(v)])):value;
export const issueKey = issue => digest(stableIssue(issue));

/** Per-command samples only. Inclusive child time is reported, never added twice. */
export function createFineTiming({now=()=>performance.now()}={}) {
  const startedUtc=new Date().toISOString(),start=now(),events=[],stack=[];
  const phases=['inputRead','prepare','scope','compile','bodySolve','labelSolve','audit','preview','files','implementationIdentity','reconstruction'];
  const begin=name=>{const event={id:events.length,name,parent:stack.at(-1)??null,startSeconds:(now()-start)/1000,status:'running',seconds:null,exclusiveSeconds:null};events.push(event);stack.push(event.id);return event;};
  const end=(event,error)=>{event.endSeconds=(now()-start)/1000;event.seconds=event.endSeconds-event.startSeconds;event.status=error?'failed':'completed';event.exclusiveSeconds=Math.max(0,event.seconds-events.filter(e=>e.parent===event.id).reduce((sum,e)=>sum+(e.seconds??0),0));if(error)event.error={code:error.code??'ERROR',message:error.message};stack.pop();};
  const sync=(name,fn)=>{const event=begin(name);try{const value=fn();end(event);return value;}catch(error){end(event,error);throw error;}};
  const run=async(name,fn)=>{const event=begin(name);try{const value=await fn();end(event);return value;}catch(error){end(event,error);throw error;}};
  const snapshot=()=>({schemaVersion:1,kind:'flitrealize.fine-layout.timing',startedUtc,capturedUtc:new Date().toISOString(),wallSeconds:(now()-start)/1000,phases:Object.fromEntries(phases.map(name=>{
    const rows=events.filter(e=>e.name===name);return [name,rows.length?{status:rows.some(e=>e.status==='failed')?'failed':rows.some(e=>e.status==='running')?'running':'completed',seconds:rows.reduce((s,e)=>s+(e.seconds??0),0),exclusiveSeconds:rows.reduce((s,e)=>s+(e.exclusiveSeconds??0),0),samples:rows.length}:{status:'not-run',seconds:null,exclusiveSeconds:null,samples:0}];
  })),events:structuredClone(events),accounting:'Phase seconds are inclusive. Audit can be nested within reconstruction or preview; use exclusiveSeconds or top-level events when summing. Wall time includes gaps and setup. Final timing.json serialization/write, CLI stdout and process startup are outside this sample.'});
  return {sync,run,snapshot};
}
