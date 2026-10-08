"""Configurable two-layer A* and patterned fanout, operating on explicit JSON data.

Pads/virtual reservations use conservative bounding rectangles in this backend.
The independent Node verifier checks the actual supplied conductive shapes.
"""
import copy
import heapq
import math
import time
from collections import Counter, deque
import numpy as np

try:
    from .geometry import rect, centre, seg_rect, point_seg, seg_gap, bbox_shape, outside_length
    from .defaults import DEFAULT_ROUTING, DEFAULT_VIA, routing_config
except ImportError:
    from geometry import rect, centre, seg_rect, point_seg, seg_gap, bbox_shape, outside_length
    from defaults import DEFAULT_ROUTING, DEFAULT_VIA, routing_config

MIL_MM = .0254


def validate_input(data, require_component_copper=True):
    def require(ok, name):
        if not ok:
            raise ValueError('PREROUTE_INPUT:' + name)

    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def positive(value, name, zero=False):
        require(finite(value) and (value >= 0 if zero else value > 0), name)

    require(isinstance(data, dict) and data.get('schemaVersion') == 1, 'schemaVersion')
    require('units' not in data or data['units'] == 'mil', 'units-must-be-mil')
    for k in ['routing', 'via', 'diagnostics', 'ground', 'fanoutOptions', 'verification']:
        if k in data:
            require(isinstance(data[k], dict), k)
    for k in ['parts', 'fanouts', 'keepouts', 'fanoutRequests', 'requestedNets']:
        if k in data:
            require(isinstance(data[k], list), k)
    routing, via = routing_config(data)
    layer_ids = routing['layerIds']
    require(isinstance(layer_ids, list) and len(layer_ids) == 2 and len(set(layer_ids)) == 2 and all(isinstance(l, int) for l in layer_ids), 'two-layer-backend-requires-exactly-two-layerIds')
    require(isinstance(data.get('boardMil'), list) and len(data['boardMil']) == 2, 'boardMil')
    for v in data['boardMil']:
        positive(v, 'boardMil')
    for k in ['gridMil', 'clearanceMil', 'copperEdgeMil']:
        positive(data.get(k), k, k != 'gridMil')
    require(data['copperEdgeMil'] * 2 < min(data['boardMil']), 'copperEdgeMil')
    for k in ['minimumSensitiveToSwitchMil', 'preferredSensitiveToSwitchMil']:
        if k in data:
            positive(data[k], k, True)
    sensitive_minimum = data.get('minimumSensitiveToSwitchMil', data['clearanceMil'])
    require(sensitive_minimum >= data['clearanceMil'], 'minimumSensitiveToSwitchMil')
    require(data.get('preferredSensitiveToSwitchMil', sensitive_minimum) >= sensitive_minimum, 'preferredSensitiveToSwitchMil')
    for k in ['bottomWeight', 'viaCostMil', 'maxVisited', 'maxSeconds', 'maxLaunchOptions']:
        positive(routing[k], 'routing.' + k)
    require(routing['bottomWeight'] >= 1, 'routing.bottomWeight')
    for k in ['powerGoalThresholdMil', 'maskWireGuardMil', 'escapeMaxOutsideMil', 'escapeSearchOutsideMil']:
        positive(routing[k], 'routing.' + k, True)
    require(routing['escapeSearchOutsideMil'] <= routing['escapeMaxOutsideMil'], 'routing.escapeSearchOutsideMil')
    for k in ['launchLengthsMil', 'escapeStemsMil', 'escapeTotalsMil', 'escapeShiftsMil']:
        require(isinstance(routing[k], list) and routing[k] and all(finite(v) for v in routing[k]), 'routing.' + k)
    for k in ['diameterMil', 'holeMil', 'drillPadClearanceMil', 'drillCenterSpacingMil', 'viaCenterSpacingMil']:
        positive(via[k], 'via.' + k, k not in ['diameterMil', 'holeMil'])
    require(via['holeMil'] < via['diameterMil'], 'via.holeMil')

    def layers(value, name):
        require(isinstance(value, list) and value and len(set(value)) == len(value) and all(l in layer_ids for l in value), name)

    def point(value, name):
        require(isinstance(value, (list, tuple)) and len(value) == 2 and all(finite(v) for v in value), name)

    def shape(value, name):
        require(isinstance(value, dict), name)
        layers(value.get('layers'), name + '.layers')
        kind = value.get('kind')
        if kind == 'polygon':
            require(isinstance(value.get('points'), list) and len(value['points']) >= 3, name + '.points')
            for p in value['points']:
                point(p, name + '.point')
        elif kind in ['capsule', 'circle']:
            for k in (['a', 'b'] if kind == 'capsule' else ['center']):
                point(value.get(k), name + '.' + k)
            positive(value.get('radius'), name + '.radius', True)
        else:
            require(False, name + '.kind')

    ids = {}
    all_ids = set()
    for key in ['pads', 'segments', 'vias']:
        require(isinstance(data.get(key), list), key)
        ids[key] = {}
        for row in data[key]:
            ident = row.get('id')
            require(isinstance(ident, str) and ident and ident not in all_ids, key + '.id')
            all_ids.add(ident)
            ids[key][ident] = row
            require(isinstance(row.get('net'), str), key + '.net')
            if key == 'pads':
                b = row.get('bbox', {})
                require(all(finite(b.get(k)) for k in ['minX', 'minY', 'maxX', 'maxY']) and b['minX'] <= b['maxX'] and b['minY'] <= b['maxY'], 'pads.bbox')
                shape(row.get('shape'), 'pads.shape')
                for k in ['contactShapes', 'shapes']:
                    require(isinstance(row.get(k), list) and row[k], 'pads.' + k)
                    for s in row[k]:
                        shape(s, 'pads.' + k)
            elif key == 'segments':
                require(all(finite(row.get(k)) for k in ['x1', 'y1', 'x2', 'y2']), 'segments.xy')
                positive(row.get('width'), 'segments.width')
                layers([row.get('layer')], 'segments.layer')
            else:
                point([row.get('x'), row.get('y')], 'vias.xy')
                positive(row.get('diameter'), 'vias.diameter')
                positive(row.get('hole'), 'vias.hole')
                require(row['hole'] < row['diameter'], 'vias.hole')
                layers(row.get('layers'), 'vias.layers')
    for f in data.get('fanouts', []):
        b = f.get('bbox', {})
        require(all(finite(b.get(k)) for k in ['minX', 'minY', 'maxX', 'maxY']) and b['minX'] <= b['maxX'] and b['minY'] <= b['maxY'], 'fanouts.bbox')
        layers(f.get('layers'), 'fanouts.layers')
    for k in data.get('keepouts', []):
        shape(k.get('shape'), 'keepouts.shape')
    require(isinstance(data.get('nets'), list), 'nets')
    names = set()
    for n in data['nets']:
        require(isinstance(n.get('net'), str) and n['net'] not in names, 'nets.net')
        names.add(n['net'])
        for k in ['widthMil', 'localWidthMil']:
            positive(n.get(k), 'nets.' + k)
        if 'escapeMaxOutsideMil' in n:
            positive(n['escapeMaxOutsideMil'], 'nets.escapeMaxOutsideMil', True)
        if 'priority' in n:
            require(finite(n['priority']), 'nets.priority')
        for k in ['sensitive', 'baselineConnected', 'pairedHold']:
            if k in n:
                require(isinstance(n[k], bool), 'nets.' + k)
        if 'allowedLayers' in n:
            layers(n['allowedLayers'], 'nets.allowedLayers')
        components = n.get('components')
        require(isinstance(components, list), 'nets.components')
        require((not components and n.get('rootIndex') == -1) or (components and isinstance(n.get('rootIndex'), int) and 0 <= n['rootIndex'] < len(components)), 'nets.rootIndex')
        for c in components:
            positive(c.get('widthMil'), 'components.widthMil')
            if 'allowedLayers' in c:
                layers(c['allowedLayers'], 'components.allowedLayers')
            for k, source in [('pads', 'pads'), ('wires', 'segments'), ('vias', 'vias')]:
                require(isinstance(c.get(k), list) and all(isinstance(i, str) for i in c[k]), 'components.' + k)
                if k == 'pads' or require_component_copper:
                    require(all(i in ids[source] and ids[source][i]['net'] == n['net'] for i in c[k]), 'components.' + k + '.references')
    require(isinstance(data.get('requestedNets', []), list) and all(n in names for n in data.get('requestedNets', [])), 'requestedNets')
    require(isinstance(data.get('fanoutRequests', []), list), 'fanoutRequests')
    for r in data.get('fanoutRequests', []):
        require(r.get('padId') in ids['pads'], 'fanoutRequests.padId')
        if 'widthMil' in r:
            positive(r['widthMil'], 'fanoutRequests.widthMil')
        if 'priority' in r:
            require(finite(r['priority']), 'fanoutRequests.priority')
        if 'layer' in r:
            layers([r['layer']], 'fanoutRequests.layer')
        if 'normal' in r:
            require(isinstance(r['normal'], list) and tuple(r['normal']) in [(1, 0), (-1, 0), (0, 1), (0, -1)], 'fanoutRequests.normal')
        for k in ['depthsMil', 'tangentsMil']:
            if k in r:
                require(isinstance(r[k], list) and r[k] and all(finite(v) for v in r[k]), 'fanoutRequests.' + k)
    return data


class Router:
    def __init__(self, data, require_component_copper=True):
        validate_input(data, require_component_copper)
        self.data = copy.deepcopy(data)
        self.config, self.via = routing_config(data)
        self.layers = self.config['layerIds']
        self.grid = data['gridMil']
        self.width, self.height = data['boardMil']
        self.nx, self.ny = math.floor(self.width / self.grid) + 1, math.floor(self.height / self.grid) + 1
        self.n = self.nx * self.ny
        if self.n > data.get('maxGridCellsPerLayer', 10000000):
            raise ValueError('PREROUTE_INPUT:grid-too-large')
        self.pads = self.data['pads']
        self.wires = self.data['segments']
        self.vias = self.data['vias']
        self.by_pad = {p['id']: p for p in self.pads}
        self.by_wire = {s['id']: s for s in self.wires}
        self.by_via = {v['id']: v for v in self.vias}
        self.nets = {n['net']: n for n in self.data['nets']}
        self.sensitive = {n['net'] for n in self.data['nets'] if n.get('sensitive')}
        reserved = [{'net': f['net'], 'bbox': f['bbox'], 'layers': f['layers'], 'virtual': True} for f in data.get('fanouts', [])]
        for k in data.get('keepouts', []):
            reserved.append({'net': '__keepout__', 'bbox': dict(zip(['minX', 'minY', 'maxX', 'maxY'], bbox_shape(k['shape']))),
                             'layers': k['shape']['layers'], 'virtual': True, 'hardKeepout': True})
        self.all_pads = self.pads + reserved

    def layer_visible(self, pad, layer):
        return layer in pad.get('layers', pad.get('shape', {}).get('layers', [pad.get('layer', self.layers[0])]))

    def allowed_layers(self, net, component=None):
        allowed = self.nets.get(net, {}).get('allowedLayers', self.layers)
        if component is not None:
            allowed = [l for l in allowed if l in component.get('allowedLayers', self.layers)]
        return allowed

    def clearance(self, net, other, preferred=False):
        if (net in self.sensitive and other in self.data.get('noiseNets', [])) or (other in self.sensitive and net in self.data.get('noiseNets', [])):
            minimum = self.data.get('minimumSensitiveToSwitchMil', self.data['clearanceMil'])
            return self.data.get('preferredSensitiveToSwitchMil', minimum) if preferred else minimum
        return self.data['clearanceMil']

    def exact(self, a, b, width, net, layer, preferred=False):
        m, edge = width / 2, self.data['copperEdgeMil']
        if min(a[0], b[0]) - m < edge - 1e-5 or min(a[1], b[1]) - m < edge - 1e-5 or max(a[0], b[0]) + m > self.width - edge + 1e-5 or max(a[1], b[1]) + m > self.height - edge + 1e-5:
            return False
        for pad in self.all_pads:
            if pad['net'] == net or not self.layer_visible(pad, layer):
                continue
            r = rect(pad)
            margin = m + (0 if pad.get('virtual') else self.clearance(net, pad['net'], preferred))
            if seg_rect(a, b, (r[0] - margin, r[1] - margin, r[2] + margin, r[3] + margin)):
                return False
        for s in self.wires:
            if s['net'] != net and s['layer'] == layer and seg_gap(a, b, (s['x1'], s['y1']), (s['x2'], s['y2'])) < m + s['width'] / 2 + self.clearance(net, s['net'], preferred) - 1e-5:
                return False
        for v in self.vias:
            if v['net'] != net and layer in v['layers'] and point_seg((v['x'], v['y']), a, b) < m + v['diameter'] / 2 + self.clearance(net, v['net'], preferred) - 1e-5:
                return False
        return True

    def region(self, b, margin=0):
        return (max(0, math.floor((b[0] - margin) / self.grid)), max(0, math.floor((b[1] - margin) / self.grid)),
                min(self.nx - 1, math.ceil((b[2] + margin) / self.grid)), min(self.ny - 1, math.ceil((b[3] + margin) / self.grid)))

    def paint_rect(self, mask, b, margin):
        x1, y1, x2, y2 = self.region(b, margin)
        if x2 < x1 or y2 < y1:
            return
        x, y = np.arange(x1, x2 + 1) * self.grid, np.arange(y1, y2 + 1) * self.grid
        mask[y1:y2 + 1, x1:x2 + 1] |= (x[None, :] >= b[0] - margin) & (x[None, :] <= b[2] + margin) & (y[:, None] >= b[1] - margin) & (y[:, None] <= b[3] + margin)

    def paint_capsule(self, mask, a, b, radius):
        x1, y1, x2, y2 = self.region((min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])), radius)
        if x2 < x1 or y2 < y1:
            return
        x = (np.arange(x1, x2 + 1) * self.grid)[None, :]
        y = (np.arange(y1, y2 + 1) * self.grid)[:, None]
        dx, dy = b[0] - a[0], b[1] - a[1]
        den = dx * dx + dy * dy
        t = np.clip(((x - a[0]) * dx + (y - a[1]) * dy) / den, 0, 1) if den else 0
        mask[y1:y2 + 1, x1:x2 + 1] |= (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2 <= radius * radius

    def paint_shape(self, mask, shape, margin=0):
        if shape['kind'] == 'polygon':
            self.paint_rect(mask, bbox_shape(shape), margin)
        else:
            a = shape.get('a', shape.get('center'))
            self.paint_capsule(mask, a, shape.get('b', a), shape['radius'] + margin)

    def masks(self, net, width, preferred=False):
        out, vbad = np.zeros((2, self.ny, self.nx), dtype=bool), np.zeros((self.ny, self.nx), dtype=bool)
        radius, edge = self.via['diameterMil'] / 2, self.data['copperEdgeMil']
        def edges(mask, margin):
            self.paint_rect(mask, (-margin, -margin, margin, self.height + margin), 0)
            self.paint_rect(mask, (self.width - margin, -margin, self.width + margin, self.height + margin), 0)
            self.paint_rect(mask, (-margin, -margin, self.width + margin, margin), 0)
            self.paint_rect(mask, (-margin, self.height - margin, self.width + margin, self.height + margin), 0)
        for z in range(2):
            edges(out[z], width / 2 + edge)
            if self.layers[z] not in self.allowed_layers(net):
                out[z] = True
        edges(vbad, radius + edge)
        for pad in self.all_pads:
            b = rect(pad)
            if pad['net'] != net:
                gap = 0 if pad.get('virtual') else self.clearance(net, pad['net'], preferred)
                for z, layer in enumerate(self.layers):
                    if self.layer_visible(pad, layer):
                        self.paint_rect(out[z], b, width / 2 + gap)
            if not pad.get('virtual'):
                # Full via copper is kept outside every pad, including same-net pads.
                pad_margin = max(radius + (self.clearance(net, pad['net'], preferred) if pad['net'] != net else 0), self.via['holeMil'] / 2 + self.via['drillPadClearanceMil'])
                self.paint_rect(vbad, b, pad_margin)
            elif pad['net'] != net:
                self.paint_rect(vbad, b, radius)
        for s in self.wires:
            if s['net'] != net:
                gap = self.clearance(net, s['net'], preferred)
                self.paint_capsule(out[self.layers.index(s['layer'])], (s['x1'], s['y1']), (s['x2'], s['y2']), width / 2 + s['width'] / 2 + gap + self.config['maskWireGuardMil'])
                self.paint_capsule(vbad, (s['x1'], s['y1']), (s['x2'], s['y2']), radius + s['width'] / 2 + gap)
        for v in self.vias:
            q, gap = (v['x'], v['y']), self.clearance(net, v['net'], preferred) if v['net'] != net else 0
            self.paint_capsule(vbad, q, q, max(self.via['drillCenterSpacingMil'], radius + v['diameter'] / 2 + gap))
            if v['net'] != net:
                for z, layer in enumerate(self.layers):
                    if layer in v['layers']:
                        self.paint_capsule(out[z], q, q, width / 2 + v['diameter'] / 2 + gap + self.config['maskWireGuardMil'])
        return out, vbad

    def goals(self, component, width):
        g, eligible = np.zeros((2, self.ny, self.nx), dtype=bool), []
        threshold = self.config['powerGoalThresholdMil']
        for ident in component['pads']:
            pad, b = self.by_pad[ident], rect(self.by_pad[ident])
            if width >= threshold and min(b[2] - b[0], b[3] - b[1]) < width:
                continue
            eligible.append(ident)
            for shape in pad['contactShapes']:
                for layer in shape['layers']:
                    self.paint_shape(g[self.layers.index(layer)], shape)
        for ident in component['wires']:
            s = self.by_wire[ident]
            if width >= threshold and s['width'] < width:
                continue
            self.paint_capsule(g[self.layers.index(s['layer'])], (s['x1'], s['y1']), (s['x2'], s['y2']), s['width'] / 2 + width / 2 - .05)
        if width < threshold:
            for ident in component['vias']:
                v, q = self.by_via[ident], (self.by_via[ident]['x'], self.by_via[ident]['y'])
                for layer in v['layers']:
                    self.paint_capsule(g[self.layers.index(layer)], q, q, v['diameter'] / 2)
        return g, eligible

    def new_via(self, net, q):
        return {'net': net, 'x': q[0], 'y': q[1], 'diameter': self.via['diameterMil'], 'hole': self.via['holeMil'], 'layers': self.layers[:]}

    def neighbours(self, point):
        gx, gy = round(point[0] / self.grid), round(point[1] / self.grid)
        return [(x, y) for x, y in [(gx, gy), (gx + 1, gy), (gx - 1, gy), (gx, gy + 1), (gx, gy - 1)] if 0 <= x < self.nx and 0 <= y < self.ny]

    def launches(self, component, width, net, blocked, preferred=False, escape_width=None, via_bad=None):
        escape_width = width if escape_width is None else escape_width
        options, unique = [], set()
        allowed = self.allowed_layers(net, component)
        for ident in component['wires']:
            s = self.by_wire[ident]
            if s['layer'] not in allowed:
                continue
            for fraction in [0, .25, .5, .75, 1]:
                point = (s['x1'] + fraction * (s['x2'] - s['x1']), s['y1'] + fraction * (s['y2'] - s['y1']))
                for x, y in self.neighbours(point):
                    q = (x * self.grid, y * self.grid)
                    if point_seg(q, (s['x1'], s['y1']), (s['x2'], s['y2'])) > s['width'] / 2 - .01:
                        continue
                    z = self.layers.index(s['layer'])
                    key = z * self.n + y * self.nx + x
                    if key not in unique and not blocked[z, y, x] and self.exact(q, q, width, net, s['layer'], preferred):
                        options.append((key, q, q, q, s['layer'], '__wire__' + ident, 0, width, [q, q], None))
                        unique.add(key)
                    other = 1 - z
                    if self.layers[other] in allowed and via_bad is not None and not via_bad[y, x] and not blocked[other, y, x] and self.exact(q, q, width, net, self.layers[other], preferred):
                        key = other * self.n + y * self.nx + x
                        if key not in unique:
                            options.append((key, q, q, q, self.layers[other], '__wire__' + ident, self.config['viaCostMil'], width, [q, q], self.new_via(net, q)))
                            unique.add(key)
        for ident in component['vias']:
            v, a = self.by_via[ident], (self.by_via[ident]['x'], self.by_via[ident]['y'])
            for layer in v['layers']:
                if layer not in allowed:
                    continue
                z = self.layers.index(layer)
                for x, y in self.neighbours(a):
                    q, key = (x * self.grid, y * self.grid), z * self.n + y * self.nx + x
                    if key not in unique and not blocked[z, y, x] and self.exact(a, q, width, net, layer, preferred):
                        options.append((key, a, a, q, layer, '__connected_via__' + ident, math.dist(a, q), width, [a, q], None))
                        unique.add(key)
        for ident in component['pads']:
            pad, a, b = self.by_pad[ident], centre(self.by_pad[ident]), rect(self.by_pad[ident])
            if escape_width == width and width >= self.config['powerGoalThresholdMil'] and min(b[2] - b[0], b[3] - b[1]) < width:
                continue
            paths = [[a, (a[0] + dx * length, a[1] + dy * length)] for dx, dy in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] for length in ([0] if dx == dy == 0 else self.config['launchLengthsMil'])]
            if escape_width < width:
                mates = [centre(self.by_pad[i]) for i in component['pads'] if self.by_pad[i].get('owner') == pad.get('owner')]
                mx, my = sum(x for x, y in mates) / len(mates), sum(y for x, y in mates) / len(mates)
                for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                    shifts = set(self.config['escapeShiftsMil'] + [my - a[1] if dx else mx - a[0]])
                    for stem in self.config['escapeStemsMil']:
                        for total in self.config['escapeTotalsMil']:
                            for shift in shifts:
                                k = (a[0] + dx * stem, a[1] + dy * stem)
                                mid = (k[0] - dy * shift, k[1] + dx * shift)
                                end = (a[0] + dx * total - dy * shift, a[1] + dy * total + dx * shift)
                                paths.append([a, k, mid, end])
            for layer in pad['shape']['layers']:
                if layer not in allowed:
                    continue
                z = self.layers.index(layer)
                for path in paths:
                    end = path[-1]
                    max_outside = min(self.config['escapeSearchOutsideMil'], self.nets[net].get('escapeMaxOutsideMil', self.config['escapeMaxOutsideMil']))
                    if escape_width < width and sum(outside_length(x, y, b) for x, y in zip(path, path[1:])) > max_outside:
                        continue
                    if not all(self.exact(x, y, escape_width, net, layer, preferred) for x, y in zip(path, path[1:])):
                        continue
                    for x, y in self.neighbours(end):
                        point = (x * self.grid, y * self.grid)
                        if not self.exact(end, point, escape_width, net, layer, preferred):
                            continue
                        full = path + [point]
                        if escape_width < width and sum(outside_length(a1, b1, b) for a1, b1 in zip(full, full[1:])) > max_outside:
                            continue
                        modes = []
                        if not blocked[z, y, x] and self.exact(point, point, width, net, layer, preferred):
                            modes.append((z, None))
                        other = 1 - z
                        if escape_width < width and self.layers[other] in allowed and via_bad is not None and not via_bad[y, x] and not blocked[other, y, x] and self.exact(point, point, width, net, self.layers[other], preferred):
                            modes.append((other, self.new_via(net, point)))
                        for zz, preset in modes:
                            key = zz * self.n + y * self.nx + x
                            if key not in unique:
                                cost = sum(math.dist(a1, b1) for a1, b1 in zip(full, full[1:])) + (self.config['viaCostMil'] if preset else 0)
                                options.append((key, a, end, point, layer, ident, cost, escape_width, full, preset))
                                unique.add(key)
            if len(options) > self.config['maxLaunchOptions']:
                break
        return options

    def search(self, component, tree, net, width, preferred=False):
        started = time.monotonic()
        blocked, via_bad = self.masks(net, width, preferred)
        allowed = self.allowed_layers(net, component)
        for z, layer in enumerate(self.layers):
            if layer not in allowed:
                blocked[z] = True
        target, _ = self.goals(tree, width)
        target &= ~blocked
        local = min(width, self.nets[net]['localWidthMil'])
        goal_escapes = {}
        if local < width:
            for option in self.launches(tree, width, net, blocked, preferred, local, via_bad):
                key = option[0]
                z, k2 = divmod(key, self.n)
                y, x = divmod(k2, self.nx)
                if not target[z, y, x]:
                    goal_escapes[key], target[z, y, x] = option, True
        if not target.any():
            return None, {'reason': 'no-grid-goal', 'widthMil': width}
        starts = self.launches(component, width, net, blocked, preferred, local, via_bad)
        if not starts:
            return None, {'reason': 'no-grid-launch', 'widthMil': width}
        gy, gx = np.nonzero(target.any(axis=0))
        goal_box = gx.min(), gy.min(), gx.max(), gy.max()
        vf, bf, tf = via_bad.ravel(), blocked.ravel(), target.ravel()
        dist, parent = np.full(self.n * 2, np.inf), np.full(self.n * 2, -2, dtype=np.int32)
        origins, queue = {}, []

        def heuristic(x, y):
            dx, dy = max(goal_box[0] - x, 0, x - goal_box[2]), max(goal_box[1] - y, 0, y - goal_box[3])
            return self.grid * (max(dx, dy) + (math.sqrt(2) - 1) * min(dx, dy))

        for option in starts:
            key, g = option[0], option[6]
            y, x = divmod(key % self.n, self.nx)
            if g < dist[key]:
                dist[key], parent[key], origins[key] = g, -1, option
                heapq.heappush(queue, (g + heuristic(x, y), g, key))
        directions = [(dx, dy, self.grid * (math.sqrt(2) if dx and dy else 1)) for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]]
        visited = 0
        while queue:
            _, g, key = heapq.heappop(queue)
            if g > dist[key] + 1e-7:
                continue
            z, k2 = divmod(key, self.n)
            y, x = divmod(k2, self.nx)
            if tf[key]:
                keys = [key]
                while parent[keys[-1]] >= 0:
                    keys.append(int(parent[keys[-1]]))
                keys.reverse()
                start = origins[keys[0]]
                path = [(k // self.n, ((k % self.n) % self.nx) * self.grid, ((k % self.n) // self.nx) * self.grid) for k in keys]
                route, new_vias = [], [start[9]] if start[9] else []
                for a, b in zip(start[8], start[8][1:]):
                    if math.dist(a, b) > 1e-7:
                        route.append((start[4], a, b))
                prefix_count, last = len(route), path[0]
                head, previous_direction = last, None
                for point in path[1:]:
                    if point[0] != last[0]:
                        if head[1:] != last[1:]:
                            route.append((self.layers[last[0]], head[1:], last[1:]))
                        new_vias.append(self.new_via(net, point[1:]))
                        head, previous_direction = point, None
                    else:
                        direction = (point[1] - last[1], point[2] - last[2])
                        if previous_direction is not None and direction != previous_direction:
                            if head[1:] != last[1:]:
                                route.append((self.layers[last[0]], head[1:], last[1:]))
                            head = last
                        previous_direction = direction
                    last = point
                if head[1:] != last[1:]:
                    route.append((self.layers[last[0]], head[1:], last[1:]))
                launch_width = start[7]
                output = []
                for i, (layer, a, b) in enumerate(route):
                    narrow = i < prefix_count and launch_width < width
                    output.append({'net': net, 'layer': layer, 'width': launch_width if i < prefix_count else width,
                                   'x1': a[0], 'y1': a[1], 'x2': b[0], 'y2': b[1],
                                   'kind': 'bounded-power-escape' if narrow else 'inter-block',
                                   'escapePadId': start[5] if narrow else None,
                                   'escapeGroupId': net + '-' + str(len(self.wires)) + '-source' if narrow else None})
                if key in goal_escapes:
                    option = goal_escapes[key]
                    if option[9]:
                        new_vias.append(option[9])
                    reverse = list(reversed(option[8]))
                    for a, b in zip(reverse, reverse[1:]):
                        if math.dist(a, b) > 1e-7:
                            narrow = option[7] < width
                            output.append({'net': net, 'layer': option[4], 'width': option[7],
                                           'x1': a[0], 'y1': a[1], 'x2': b[0], 'y2': b[1],
                                           'kind': 'bounded-power-escape' if narrow else 'inter-block',
                                           'escapePadId': option[5] if narrow else None,
                                           'escapeGroupId': net + '-' + str(len(self.wires)) + '-goal' if narrow else None})
                if not all(self.exact((s['x1'], s['y1']), (s['x2'], s['y2']), s['width'], net, s['layer'], preferred) for s in output):
                    return None, {'reason': 'exact-geometry-reject', 'visited': visited}
                new_vias = list({(v['x'], v['y']): v for v in new_vias}.values())
                # A via can be valid against old copper but two fresh transitions
                # can be too close; the independent verifier also checks this.
                if any(math.dist((a['x'], a['y']), (b['x'], b['y'])) < self.via['drillCenterSpacingMil'] - 1e-5 for i, a in enumerate(new_vias) for b in new_vias[i + 1:]):
                    return None, {'reason': 'new-via-spacing-reject', 'visited': visited}
                return {'segments': output, 'vias': new_vias}, {'visited': visited, 'seconds': time.monotonic() - started,
                    'widthMil': width, 'localEscapeWidthMil': local, 'preferredNoiseGap': preferred}
            visited += 1
            if visited > self.config['maxVisited'] or time.monotonic() - started > self.config['maxSeconds']:
                return None, {'reason': 'search-budget', 'visited': visited, 'seconds': time.monotonic() - started}
            for dx, dy, cost in directions:
                xx, yy = x + dx, y + dy
                if not (0 <= xx < self.nx and 0 <= yy < self.ny):
                    continue
                q = z * self.n + yy * self.nx + xx
                if bf[q] or dx and dy and (bf[z * self.n + y * self.nx + xx] or bf[z * self.n + yy * self.nx + x]):
                    continue
                ng = g + cost * (1 if z == 0 else self.config['bottomWeight'])
                if ng + 1e-7 < dist[q]:
                    dist[q], parent[q] = ng, key
                    heapq.heappush(queue, (ng + heuristic(xx, yy), ng, q))
            if not vf[k2]:
                q, ng = (1 - z) * self.n + k2, g + self.config['viaCostMil']
                if not bf[q] and ng + 1e-7 < dist[q]:
                    dist[q], parent[q] = ng, key
                    heapq.heappush(queue, (ng + heuristic(x, y), ng, q))
        return None, {'reason': 'no-route', 'visited': visited, 'seconds': time.monotonic() - started}

    def add_copper(self, segments, vias, prefix, added, added_vias):
        occupied = set(self.by_pad) | set(self.by_wire) | set(self.by_via)
        def ident(kind, counter):
            value = f'{prefix}-{kind}-{counter}'
            while value in occupied:
                counter += 1
                value = f'{prefix}-{kind}-{counter}'
            occupied.add(value)
            return value
        for s in segments:
            s['id'] = ident('wire', len(added))
            added.append(s)
            self.wires.append(s)
            self.by_wire[s['id']] = s
        for v in vias:
            v['id'] = ident('via', len(added_vias))
            added_vias.append(v)
            self.vias.append(v)
            self.by_via[v['id']] = v


def route(data, checkpoint=None, progress=None):
    router, began = Router(data), time.monotonic()
    records, added, new_vias = [], [], []
    requested = data.get('requestedNets', [])
    net_order = sorted(data['nets'], key=lambda n: (n.get('priority', 0), n['net']))

    def result(status='offline-preroute-complete'):
        return {'status': status, 'nets': records, 'segments': added, 'vias': new_vias,
                'wallSeconds': time.monotonic() - began, 'nativeWrites': 0,
                'backend': 'local-grid-two-layer-A*', 'gridMil': router.grid, 'pendingGround': True,
                'delegatedNets': data.get('delegatedNets', []),
                'scope': 'two-layer signal/power candidate; delegated ground-plane nets are not routed or verified by this job'}

    for n in net_order:
        net = n['net']
        if requested and net not in requested:
            continue
        if n.get('baselineConnected') or n.get('pairedHold'):
            records.append({'net': net, 'status': 'preserved-connected' if n.get('baselineConnected') else 'held-pair', 'addedSegments': 0, 'addedVias': 0})
            if checkpoint:
                checkpoint(result('running'))
            continue
        if not n['components']:
            records.append({'net': net, 'status': 'no-pad-components', 'addedSegments': 0, 'addedVias': 0})
            continue
        if progress:
            progress({'progress': 'inter-block-start', 'net': net, 'islands': len(n['components'])})
        components = copy.deepcopy(n['components'])
        tree = components.pop(n['rootIndex'])
        bridges, failures = [], []
        while components:
            def distance(c):
                return min((math.dist(centre(router.by_pad[a]), centre(router.by_pad[b])) for a in c['pads'] for b in tree['pads']), default=math.inf)
            component = min(components, key=distance)
            trial, detail = None, None
            for preferred in ([True, False] if n.get('sensitive') else [False]):
                trial, detail = router.search(component, tree, net, component['widthMil'], preferred)
                if trial:
                    break
            if not trial:
                failures.append({'owners': component.get('owners', []), **detail})
                components.remove(component)
                continue
            for s in trial['segments']:
                s['bridgeComponentPadIds'] = component['pads'][:]
            router.add_copper(trial['segments'], trial['vias'], 'cross', added, new_vias)
            for key in ['pads', 'wires', 'vias']:
                additions = [s['id'] for s in trial['segments']] if key == 'wires' else [v['id'] for v in trial['vias']] if key == 'vias' else []
                tree[key] += component[key] + additions
            components.remove(component)
            bridges.append({'owners': component.get('owners', []), 'role': component.get('role', 'ordinary_signal'),
                            'segments': len(trial['segments']), 'vias': len(trial['vias']), **detail})
            if checkpoint:
                checkpoint(result('running'))
        record = {'net': net, 'status': 'candidate-connected' if not failures else 'partial-or-blocked',
                  'bridges': bridges, 'failures': failures, 'addedSegments': sum(b['segments'] for b in bridges),
                  'addedVias': sum(b['vias'] for b in bridges)}
        records.append(record)
        if progress:
            progress({'progress': 'inter-block-result', 'net': net, 'status': record['status'], 'failures': failures})
        if checkpoint:
            checkpoint(result('running'))
    return result()


def fanout(data):
    router, began = Router(data), time.monotonic()
    parts = {p['ref']: p for p in data.get('parts', [])}
    added, new_vias, records = [], [], []
    requests = data.get('fanoutRequests', [])
    config = data.get('fanoutOptions', {})

    def via_ok(q, net):
        radius, edge = router.via['diameterMil'] / 2, data['copperEdgeMil']
        if min(q) < radius + edge or q[0] > router.width - radius - edge or q[1] > router.height - radius - edge:
            return False
        for pad in router.all_pads:
            b = rect(pad)
            gap = math.hypot(max(b[0] - q[0], 0, q[0] - b[2]), max(b[1] - q[1], 0, q[1] - b[3]))
            need = radius + (0 if pad.get('virtual') else router.clearance(net, pad['net'])) if pad['net'] != net else radius
            if not pad.get('virtual'):
                need = max(need, router.via['holeMil'] / 2 + router.via['drillPadClearanceMil'])
            if pad.get('virtual') and pad['net'] == net:
                continue
            if gap < need - 1e-5:
                return False
        for wire in router.wires:
            if wire['net'] != net and point_seg(q, (wire['x1'], wire['y1']), (wire['x2'], wire['y2'])) < radius + wire['width'] / 2 + router.clearance(net, wire['net']) - 1e-5:
                return False
        return not any(math.dist(q, (v['x'], v['y'])) < max(router.via['viaCenterSpacingMil'], radius + v['diameter'] / 2 + (router.clearance(net, v['net']) if v['net'] != net else 0)) - 1e-5 for v in router.vias)

    for request in sorted(requests, key=lambda r: (r.get('priority', 0), r['padId'])):
        if request.get('padId') not in router.by_pad:
            raise ValueError('PREROUTE_INPUT:fanoutRequests.padId')
        pad = router.by_pad[request['padId']]
        net, a, b = pad['net'], centre(pad), rect(pad)
        if net not in router.nets:
            raise ValueError('PREROUTE_INPUT:fanoutRequests.net-not-declared')
        if router.allowed_layers(net) != router.layers and set(router.allowed_layers(net)) != set(router.layers):
            raise ValueError('PREROUTE_INPUT:fanout-via-requires-both-allowed-layers')
        layer, width = request.get('layer', router.layers[0]), request.get('widthMil', router.nets[net]['localWidthMil'])
        if layer not in pad['shape']['layers'] or layer not in router.allowed_layers(net):
            raise ValueError('PREROUTE_INPUT:fanoutRequests.layer')
        normal = request.get('normal')
        if normal is None:
            part = parts.get(pad.get('owner'))
            if not part:
                raise ValueError('PREROUTE_INPUT:fanout-requires-normal-or-part-body')
            body = part.get('bodyMil') or part.get('bboxMil')
            if not body and part.get('bodyMm'):
                body = {k: v / MIL_MM for k, v in part['bodyMm'].items()}
            if not body:
                raise ValueError('PREROUTE_INPUT:fanout-requires-normal-or-part-body')
            normal = min([(abs(a[0] - body['minX']), (-1, 0)), (abs(a[0] - body['maxX']), (1, 0)),
                          (abs(a[1] - body['minY']), (0, -1)), (abs(a[1] - body['maxY']), (0, 1))], key=lambda q: q[0])[1]
        if tuple(normal) not in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            raise ValueError('PREROUTE_INPUT:fanoutRequests.normal-must-be-cardinal')
        options = []
        for dx, dy in [normal, (-normal[0], -normal[1]), (-normal[1], normal[0]), (normal[1], -normal[0])]:
            edge_distance = (b[2] - b[0]) / 2 if dx else (b[3] - b[1]) / 2
            for depth in request.get('depthsMil', config.get('depthsMil', [24, 32, 40, 48, 64, 80, 100, 128])):
                for tangent in request.get('tangentsMil', config.get('tangentsMil', [0, -8, 8, -16, 16, -24, 24, -32, 32])):
                    q = (a[0] + dx * (edge_distance + depth) - dy * tangent, a[1] + dy * (edge_distance + depth) + dx * tangent)
                    stem = config.get('stemMil', 12)
                    k = (a[0] + dx * (edge_distance + stem), a[1] + dy * (edge_distance + stem))
                    points = [a, k, (k[0] - dy * tangent, k[1] + dx * tangent), q]
                    if not via_ok(q, net) or not all(router.exact(x, y, width, net, layer) for x, y in zip(points, points[1:])):
                        continue
                    targets = [centre(p) for p in router.pads if p['net'] == net and p['id'] != pad['id']]
                    cost = sum(math.dist(x, y) for x, y in zip(points, points[1:])) + config.get('targetDistanceWeight', .05) * min((math.dist(q, t) for t in targets), default=0) + (0 if tuple((dx, dy)) == tuple(normal) else config.get('nonNormalPenaltyMil', 20))
                    options.append((cost, points))
        if not options:
            records.append({'padId': pad['id'], 'net': net, 'status': 'no-legal-local-via'})
            continue
        _, points = min(options, key=lambda q: q[0])
        q = points[-1]
        segments = [{'net': net, 'layer': layer, 'width': width, 'x1': x[0], 'y1': x[1], 'x2': y[0], 'y2': y[1],
                     'kind': 'planned-interface-escape', 'sourcePadId': pad['id']} for x, y in zip(points, points[1:]) if math.dist(x, y) > 1e-7]
        via = {**router.new_via(net, q), 'sourcePadId': pad['id']}
        router.add_copper(segments, [via], 'fanout', added, new_vias)
        records.append({'padId': pad['id'], 'net': net, 'status': 'escape-and-via-planned', 'depthFromPadMil': math.dist(a, q), 'viaMil': q})
    return {'status': 'offline-fanout-complete', 'baselineCandidateHash': data.get('baselineCandidateHash'), 'records': records,
            'segments': added, 'vias': new_vias, 'nets': [{'net': net, 'status': 'fanout-only'} for net in sorted({s['net'] for s in added})],
            'wallSeconds': time.monotonic() - began, 'delegatedNets': data.get('delegatedNets', []), 'nativeWrites': 0}


def reachable_region(router, net, component, width, max_points):
    blocked, via_bad = router.masks(net, width)
    for z, layer in enumerate(router.layers):
        if layer not in router.allowed_layers(net, component):
            blocked[z] = True
    starts = router.launches(component, width, net, blocked, False, min(width, router.nets[net]['localWidthMil']), via_bad)
    seen, queue = {v[0] for v in starts}, deque(v[0] for v in starts)
    legal_vias = set()
    while queue and len(seen) < max_points:
        key = queue.popleft()
        z, k2 = divmod(key, router.n)
        y, x = divmod(k2, router.nx)
        if not via_bad[y, x] and not blocked[1 - z, y, x]:
            legal_vias.add(k2)
            other = (1 - z) * router.n + k2
            if other not in seen:
                seen.add(other)
                queue.append(other)
        for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            xx, yy = x + dx, y + dy
            if 0 <= xx < router.nx and 0 <= yy < router.ny:
                other = z * router.n + yy * router.nx + xx
                if not blocked[z, yy, xx] and other not in seen:
                    seen.add(other)
                    queue.append(other)
    return seen, len(starts), len(legal_vias), not queue


def diagnose(data):
    config, records, began = data.get('diagnostics', {}), [], time.monotonic()
    selected = config.get('nets', data.get('requestedNets', []))
    max_points = config.get('maxReachablePoints', 80000)
    if not isinstance(max_points, int) or max_points < 1:
        raise ValueError('PREROUTE_INPUT:diagnostics.maxReachablePoints')
    router = Router(data)
    if not isinstance(selected, list) or any(net not in router.nets for net in selected):
        raise ValueError('PREROUTE_INPUT:diagnostics.nets')
    for n in data['nets']:
        if selected and n['net'] not in selected:
            continue
        width = config.get('widthMil', n['localWidthMil'])
        for index, component in enumerate(n['components']):
            seen, launches, via_points, exhausted = reachable_region(router, n['net'], component, width, max_points)
            boundary = Counter()
            if exhausted:
                xy = [(((k % router.n) % router.nx) * router.grid, ((k % router.n) // router.nx) * router.grid) for k in seen]
                for s in router.wires:
                    if s['net'] != n['net'] and any(point_seg(q, (s['x1'], s['y1']), (s['x2'], s['y2'])) < s['width'] / 2 + width / 2 + router.clearance(n['net'], s['net']) + config.get('boundaryProbeMarginMil', 3) for q in xy):
                        boundary[s['net']] += 1
            records.append({'net': n['net'], 'componentIndex': index, 'owners': component.get('owners', []), 'launches': launches,
                            'reachableGridPoints': len(seen), 'exhaustedLocalRegion': exhausted,
                            'legalViaPoints': via_points, 'boundaryNets': dict(boundary.most_common())})
    probes = []
    for case in config.get('cutProbes', []):
        net = router.nets.get(case.get('net'))
        if net is None:
            raise ValueError('PREROUTE_INPUT:cutProbes.net')
        index = case.get('componentIndex')
        if index is None and case.get('padId'):
            index = next((i for i, c in enumerate(net['components']) if case['padId'] in c['pads']), None)
        if not isinstance(index, int) or not 0 <= index < len(net['components']):
            raise ValueError('PREROUTE_INPUT:cutProbes.componentIndex-or-padId')
        # Keep component source copper; only named foreign obstacle copper is removed.
        for removed in case.get('removeNets', []):
            if removed == net['net']:
                raise ValueError('PREROUTE_INPUT:cutProbes-cannot-remove-source-net')
            trial = Router(data)
            trial.wires = [s for s in trial.wires if s['net'] != removed]
            trial.vias = [v for v in trial.vias if v['net'] != removed]
            seen, launches, via_points, exhausted = reachable_region(trial, net['net'], net['components'][index], config.get('widthMil', net['localWidthMil']), config.get('cutMaxReachablePoints', 50000))
            probes.append({'net': net['net'], 'componentIndex': index, 'remove': removed, 'size': len(seen),
                           'launches': launches, 'legalViaPoints': via_points, 'exhausted': exhausted})
    return {'status': 'offline-grid-blockage-diagnosis', 'records': records, 'cutProbes': probes,
            'gridMil': router.grid, 'scope': 'sampled two-layer launch reachability; a blocked grid is not proof that continuous-space routing is impossible',
            'wallSeconds': time.monotonic() - began, 'nativeWrites': 0}
