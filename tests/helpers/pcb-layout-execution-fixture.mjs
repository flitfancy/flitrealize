import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shift = (b, dx, dy) => ({ minX: b.minX + dx, maxX: b.maxX + dx, minY: b.minY + dy, maxY: b.maxY + dy });
const pointAt = (p, old, next) => { const r = ((next.Rotation ?? 0) - (old.Rotation ?? 0)) * Math.PI / 180, x = p.x - old.X, y = p.y - old.Y; return { x: next.X + x * Math.cos(r) - y * Math.sin(r), y: next.Y + x * Math.sin(r) + y * Math.cos(r) }; };
const boxAt = (b, old, next) => { const ps = [[b.minX,b.minY],[b.minX,b.maxY],[b.maxX,b.minY],[b.maxX,b.maxY]].map(([x,y]) => pointAt({x,y},old,next)); return { minX: Math.min(...ps.map(p=>p.x)), minY: Math.min(...ps.map(p=>p.y)), maxX: Math.max(...ps.map(p=>p.x)), maxY: Math.max(...ps.map(p=>p.y)) }; };
const primitive = properties => new Proxy(properties, { get(o, k) { if (Object.hasOwn(o,k)) return o[k]; if (typeof k === 'string' && k.startsWith('getState_') && Object.hasOwn(o,k.slice(9))) return () => o[k.slice(9)]; return undefined; } });
export async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pcb-layout-execution-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const components = [0, 300].map((x, i) => primitive({ PrimitiveId: 'component-' + i + '/', Designator: 'U' + (i + 1), X: x, Y: 0, Rotation: 0, Layer: 1, PrimitiveLock: false, Footprint: { name: 'FIXTURE' }, bbox: { minX: x - 10, maxX: x + 10, minY: -5, maxY: 5 } }));
  const pads = components.map((c, i) => primitive({ PrimitiveId: c.PrimitiveId + 'pad-1', ParentComponentPrimitiveId:c.PrimitiveId, X: c.X, Y: 0, Rotation:0, Layer: 1, PrimitiveLock: false, Net: 'N' + i, PadNumber: '1', Pad:['RECT',4,4],Hole:null,HoleOffsetX:0,HoleOffsetY:0,HoleRotation:0,Metallization:false,bbox: { minX: c.X - 2, maxX: c.X + 2, minY: -2, maxY: 2 } }));
  pads.push(primitive({ PrimitiveId: 'testpad', ParentComponentPrimitiveId:null,X: 500, Y: 0, Rotation:0,Layer: 1, PrimitiveLock: false, Net: 'N0', PadNumber: 'TP1',Pad:['ELLIPSE',4,4],Hole:null,HoleOffsetX:0,HoleOffsetY:0,HoleRotation:0,Metallization:false, bbox: { minX: 498, maxX: 502, minY: -2, maxY: 2 } }));
  const ownership=new Map(pads.filter(p=>p.ParentComponentPrimitiveId!==null).map(p=>[p,p.ParentComponentPrimitiveId]));
  const attributes = components.map(c => primitive({ PrimitiveId: c.PrimitiveId + 'label', ParentPrimitiveId: c.PrimitiveId, Key: 'Designator', Value: c.Designator, ValueVisible: true, Layer: 3, PrimitiveLock: false, X: c.X, Y: 10, Rotation: 0, AlignMode: 'CENTER', FontSize: 4, LineWidth: 1, bbox: { minX: c.X - 4, maxX: c.X + 4, minY: 9, maxY: 11 } }));
  const strings = [], routing = { Line: [], Arc: [], Polyline: [], Via: [], Pour: [] }, regions = [], calls = [];
  const control = { saves: 0, modifications: [], saveResult: true, beforePhase: null, afterSave: null, afterComponentModify:null,pinQuery:null,pinQueries:[],failModifyId: null, roundPadReadback: false, padBboxOffsetAfterMove: 0, bodyBboxExpandAfterMove: 0, document: { uuid: 'pcb', parentProjectUuid: 'project', documentType: 3 } };
  const queryPins=async(c,method)=>{control.pinQueries.push({id:c.PrimitiveId,method});const selected=pads.filter(p=>ownership.get(p)===c.PrimitiveId).map(p=>new Proxy(p,{get(o,k){if(k==='getState_ParentComponentPrimitiveId')return()=>ownership.get(p);return o[k];}}));return control.pinQuery?control.pinQuery(c,selected,method):selected;};
  for(const c of components){c.getAllPins=()=>queryPins(c,'instance');c.getState_Pads=()=>pads.filter(p=>ownership.get(p)===c.PrimitiveId).map((p,i)=>({primitiveId:'local-'+i,padNumber:p.PadNumber,net:p.Net}));}
  const all = () => [...components, ...pads, ...attributes, ...strings, ...regions, ...Object.values(routing).flat()];
  const source = () => JSON.stringify({ components, pads, attributes, strings, routing, regions });
  const update = (a, values) => { const next = { X: values.x ?? a.X, Y: values.y ?? a.Y, Rotation: values.rotation ?? a.Rotation ?? 0 }; a.bbox = boxAt(a.bbox, a, next); for (const [k, v] of Object.entries(values)) a[k[0].toUpperCase() + k.slice(1)] = v; };
  const modify = collection => async (id, values) => { control.modifications.push(id); if (control.failModifyId === id) return false; const a = collection.find(a => a.PrimitiveId === id); update(a, values); return true; };
  const eda = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => control.document },
    sys_FileManager: { getDocumentSource: async () => source() },
    pcb_Primitive: { getPrimitivesBBox: async ids => { const a = all().find(a => a.PrimitiveId === ids[0]); let b = structuredClone(a?.bbox); if (control.modifications.length && pads.includes(a) && control.padBboxOffsetAfterMove) b = shift(b,control.padBboxOffsetAfterMove,0); if (control.modifications.length && a === components[0] && control.bodyBboxExpandAfterMove) b.maxX += control.bodyBboxExpandAfterMove; return b; } },
    pcb_PrimitiveComponent: { getAll: async () => components, getAllPinsByPrimitiveId:async id=>queryPins(components.find(c=>c.PrimitiveId===id),'class'),modify: async (id, values) => {
      const a = components.find(c => c.PrimitiveId === id), next = { X: values.x ?? a.X, Y: values.y ?? a.Y, Rotation: values.rotation ?? a.Rotation };
      if (control.failModifyId !== id) for (const child of [...pads.filter(p => ownership.get(p)===id), ...attributes.filter(p => p.ParentPrimitiveId === id)]) {
        const position = pointAt({x:child.X,y:child.Y},a,next); child.bbox=boxAt(child.bbox,a,next); child.X=position.x; child.Y=position.y;
        if (child.Rotation !== undefined) child.Rotation += next.Rotation - a.Rotation;
      }
      const result=await modify(components)(id, values);if(result&&control.afterComponentModify)await control.afterComponentModify(id,values);return result;
    } },
    pcb_PrimitivePad: { getAll: async () => control.roundPadReadback ? pads.map(p => new Proxy(p,{get(o,k){ if(k==='getState_X')return()=>Math.round(o.X*10)/10;if(k==='getState_Y')return()=>Math.round(o.Y*10)/10;return o[k];}})) : pads, modify: modify(pads) },
    pcb_PrimitiveAttribute: { getAll: async () => attributes, modify: modify(attributes) },
    pcb_PrimitiveString: { getAll: async () => strings, modify: modify(strings) },
    pcb_PrimitiveRegion: { getAll: async () => regions },
    pcb_Document: { save: async () => { control.saves++; if (control.afterSave) control.afterSave(); return control.saveResult; } },
  };
  for (const type of Object.keys(routing)) eda['pcb_Primitive' + type] = { getAll: async () => routing[type] };
  const transport = async request => { calls.push(request.phase); if (control.beforePhase) await control.beforePhase(request); try { return { success: true, result: await new (Object.getPrototypeOf(async function () {}).constructor)('eda', request.code)(eda) }; } catch (error) { return { success: false, error: { code: 'NATIVE_ERROR', message: error.message } }; } };
  let n = 0;
  const options = () => ({ projectRoot, windowId: 'window', config: { expectedProjectUuid: 'project', expectedDocumentUuid: 'pcb', clearanceMil: 8, includeFunctionalLabels: false }, reportDir: join(projectRoot, 'report-' + ++n), transport });
  const plan = (snapshot, {firstDx=100,rotation=0}={}) => ({ sourceHash: snapshot.sourceHash, issues: [], components: snapshot.components.map(c => ({ ...c, x: c.x + (c.ref === 'U1' ? firstDx : 0),rotation:c.ref==='U1'?rotation:c.rotation })), labels: snapshot.items.map(l => ({ ...l, ...l.original, x: l.original.x + (l.owner === 'U1' ? firstDx : 0), bbox: shift(l.original.bbox, l.owner === 'U1' ? firstDx : 0, 0) })), testPads: snapshot.pads.filter(p => !p.owner).map(p => ({ ...p, dx: 0, dy: 0 })) });
  return { projectRoot, options, plan, eda, transport, control, calls, components, pads, attributes, strings, routing, regions, primitive,ownership };
}
