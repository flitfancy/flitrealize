/** EasyEDA export, native pad binding and flat DSN interpretation belong to this Provider. */
import { parseSpecctra, child, children } from '../../pcb-routing/specctra.mjs';

const defaultLayerMap = { TopLayer: 1, Inner1: 15, Inner2: 16, BottomLayer: 2 };
export function normalizeBoard(exported, padRead, policy) {
  const b = exported.result ?? exported, p = padRead.result ?? padRead, ast = parseSpecctra(b.dsn?.text ?? b.dsnText);
  if ((b.objects.arcs ?? []).length || (b.objects.polylines ?? []).some(o => [1, 2, 15, 16].includes(o.Layer))) throw Error('CURVED_OR_POLYLINE_COPPER_UNSUPPORTED');
  if (policy.units !== 'mil') throw Error('ROUTING_UNITS_MUST_BE_MIL');
  const layerNames = children(child(ast, 'structure'), 'layer').map(l => l[1]), layerMap = { ...defaultLayerMap, ...b.layerMap };
  if (layerNames.some(l => !Number.isInteger(layerMap[l]))) throw Error('UNSUPPORTED_DSN_LAYER_MAP');
  const library = child(ast, 'library'), stacks = new Map(children(library, 'padstack').map(s => [s[1], s]));
  const pins = children(library, 'image').flatMap(im => children(im, 'pin').map(pin => ({ ref: im[1] + '-' + pin[2], pin, image: im[1] })));
  if (children(child(ast, 'placement'), 'component').some(c => children(c, 'place').some(p => Number(p[2]) || Number(p[3]) || Number(p[5])))) throw Error('NONFLAT_DSN_UNSUPPORTED');
  const nets = children(child(ast, 'network'), 'net'), netByPin = new Map(nets.flatMap(n => (child(n, 'pins') ?? []).slice(1).map(ref => [ref, n[1]])));
  if (b.netNames.some(n => !nets.some(x => x[1] === n))) throw Error('DSN_NET_INVENTORY_MISMATCH');
  const owners = new Map((p.components ?? []).flatMap(c => (c.pads ?? []).map(q => [c.id + q.primitiveId, { ref: c.ref, pin: q.padNumber }])));
  const pads = p.pads.map(pad => {
    let found = pins.find(p => p.ref === 'u1-' + pad.id.replace('e', ''));
    if (!found) {
      const candidates = pins.filter(p => Math.hypot(Number(p.pin[3]) - pad.x, Number(p.pin[4]) - pad.y) < .08 && (netByPin.get(p.ref) ?? '') === pad.net);
      if (candidates.length !== 1) throw Error('PAD_BINDING_AMBIGUOUS:' + pad.id);
      found = candidates[0];
    }
    const pin = found.pin;
    if (Math.hypot(Number(pin[3]) - pad.x, Number(pin[4]) - pad.y) > .08 || (netByPin.get(found.ref) ?? '') !== pad.net) throw Error('PAD_BINDING_CHANGED:' + pad.id);
    if (Number(child(pin, 'rotate')?.[1] ?? 0)) throw Error('ROTATED_DSN_PIN_UNSUPPORTED');
    const stack = stacks.get(pin[1]);
    if (!stack) throw Error('PADSTACK_MISSING');
    const x = Number(pin[3]), y = Number(pin[4]), shapes = children(stack, 'shape').map(s => {
      const g = s[1], layer = layerMap[g[1]];
      if (g[0] === 'circle') return { kind: 'circle', center: [x + Number(g[3] ?? 0), y + Number(g[4] ?? 0)], radius: Number(g[2]) / 2, layers: [layer] };
      if (g[0] === 'polygon') {
        const values = g.slice(3).map(Number);
        return { kind: 'polygon', points: Array.from({ length: values.length / 2 }, (_, i) => [x + values[2 * i], y + values[2 * i + 1]]), layers: [layer] };
      }
      throw Error('PAD_SHAPE_UNSUPPORTED:' + g[0]);
    });
    return { ...pad, ...owners.get(pad.id), x, y, shapes, dsnRef: found.ref, image: found.image };
  });
  const layers = layerNames.map(l => layerMap[l]);
  for (const via of children(child(ast, 'wiring'), 'via')) {
    const copperLayers = children(stacks.get(via[1]) ?? [], 'shape').map(s => layerMap[s[1][1]]);
    if (layers.some(l => !copperLayers.includes(l))) throw Error('NONTHROUGH_VIA_UNSUPPORTED');
  }
  const segments = b.objects.lines.map(s => ({ id: s.PrimitiveId, net: s.Net, layer: s.Layer, width: s.LineWidth, x1: s.StartX, y1: s.StartY, x2: s.EndX, y2: s.EndY, locked: s.PrimitiveLock }));
  const vias = b.objects.vias.map(v => ({ id: v.PrimitiveId, net: v.Net, x: v.X, y: v.Y, hole: v.HoleDiameter, diameter: v.Diameter, layers, locked: v.PrimitiveLock }));
  return { schemaVersion: 1, units: 'mil', provider: 'easyeda-pro', target: { project: b.project, document: b.document },
    ast, layerMap, layerNames, layers, netNames: [...b.netNames], pads, segments, vias, native: b, padRead: p };
}
