import { createHash } from 'node:crypto';

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
