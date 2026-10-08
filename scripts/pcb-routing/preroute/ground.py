"""Potential ground copper space and a conditional plane-link graph.

This is a sampled conservative capacity model, never a native copper pour,
ground connectivity proof, or a continuous-space impossibility proof.
"""
import math
import time
from collections import Counter, deque
import numpy as np

try:
    from .geometry import rect, inside_shape
    from .router import Router, MIL_MM, DEFAULT_ROUTING, routing_config
except ImportError:
    from geometry import rect, inside_shape
    from router import Router, MIL_MM, DEFAULT_ROUTING, routing_config


def erode(array, radius):
    if radius == 0:
        return array.copy()
    def window_axis(a, axis):
        pads = [(0, 0)] * a.ndim
        pads[axis] = (radius, radius)
        b = np.pad(a.astype(np.int32), pads, constant_values=0)
        zero = np.zeros_like(np.take(b, [0], axis=axis))
        cumulative = np.cumsum(np.concatenate([zero, b], axis=axis), axis=axis)
        hi, lo = [slice(None)] * a.ndim, [slice(None)] * a.ndim
        hi[axis], lo[axis] = slice(2 * radius + 1, None), slice(None, -2 * radius - 1)
        return cumulative[tuple(hi)] - cumulative[tuple(lo)] == 2 * radius + 1
    return window_axis(window_axis(array, 1), 0)


def components(array, grid):
    labels = np.zeros(array.shape, dtype=np.int32)
    parent, sizes, previous = [0], [0], []
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for y, row in enumerate(array):
        edge = np.diff(np.pad(row.astype(np.int8), (1, 1)))
        starts, ends = np.flatnonzero(edge == 1), np.flatnonzero(edge == -1) - 1
        current, j = [], 0
        for x1, x2 in zip(starts.tolist(), ends.tolist()):
            k = len(parent)
            parent.append(k)
            sizes.append(x2 - x1 + 1)
            labels[y, x1:x2 + 1] = k
            while j < len(previous) and previous[j][1] < x1:
                j += 1
            q = j
            while q < len(previous) and previous[q][0] <= x2:
                a, b = find(k), find(previous[q][2])
                if a != b:
                    parent[b] = a
                q += 1
            current.append((x1, x2, k))
        previous = current
    roots = np.array([find(i) for i in range(len(parent))], dtype=np.int32)
    counts = Counter()
    for i in range(1, len(parent)):
        counts[int(roots[i])] += sizes[i]
    ordered = sorted(counts, key=lambda k: counts[k], reverse=True)
    renumber = {k: i + 1 for i, k in enumerate(ordered)}
    mapping = np.array([renumber.get(int(r), 0) for r in roots], dtype=np.int32)
    areas = [{'id': renumber[k], 'cells': counts[k], 'areaMm2': counts[k] * (grid * MIL_MM) ** 2} for k in ordered]
    return mapping[labels], areas


def ground_space(data, candidate=None, candidate_mode='replace'):
    began, config = time.monotonic(), data.get('ground', {})
    ground_net = config.get('net', 'GND')
    guard = config.get('wholeCellGuardCells', 1)
    core_width, transition_radius = config.get('coreWidthBenchmarkMil', 30), config.get('transitionRadiusMm', 2)
    area_threshold, projection_step = config.get('regionAreaThresholdMm2', 1), config.get('projectionSampleMil', 4)
    for key, value in [('wholeCellGuardCells', guard), ('coreWidthBenchmarkMil', core_width), ('transitionRadiusMm', transition_radius), ('regionAreaThresholdMm2', area_threshold), ('projectionSampleMil', projection_step)]:
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (key == 'projectionSampleMil' and value == 0):
            raise ValueError('PREROUTE_INPUT:ground.' + key)
    if not isinstance(guard, int):
        raise ValueError('PREROUTE_INPUT:ground.wholeCellGuardCells-must-be-integer')
    router = Router(data, require_component_copper=False)
    if candidate is not None:
        if candidate_mode not in ['replace', 'additions']:
            raise ValueError('PREROUTE_INPUT:candidate-mode')
        router.wires = (router.wires if candidate_mode == 'additions' else []) + candidate['segments']
        router.vias = (router.vias if candidate_mode == 'additions' else []) + candidate['vias']
        # Validate candidate geometry/layers before painting. Net-island references
        # in historical evidence are deliberately not consumed by this model.
        Router({**data, 'segments': router.wires, 'vias': router.vias}, require_component_copper=False)
    blocked, via_bad = router.masks(ground_net, 0)
    free = np.stack([erode(~blocked[z], guard) for z in range(2)])
    labels, cores, records = [], [], []
    board_area = data['boardMil'][0] * data['boardMil'][1] * MIL_MM ** 2
    for z in range(2):
        lab, area = components(free[z], router.grid)
        labels.append(lab)
        wide = erode(free[z], math.ceil(core_width / 2 / router.grid))
        _, wide_area = components(wide, router.grid)
        cores.append(wide)
        available = float(free[z].sum() * (router.grid * MIL_MM) ** 2)
        records.append({'layer': router.layers[z], 'availableAreaMm2': available,
            'availableBoardFraction': available / board_area,
            'regionsAtLeastThreshold': sum(r['areaMm2'] >= area_threshold for r in area),
            'regionAreaThresholdMm2': area_threshold,
            'largestRegionMm2': area[0]['areaMm2'] if area else 0,
            'largestFractionOfAvailable': area[0]['cells'] / int(free[z].sum()) if area else 0,
            'coreWidthBenchmarkMil': core_width,
            'coreRegionsAtLeastThreshold': sum(r['areaMm2'] >= area_threshold for r in wide_area),
            'largestCoreRegionMm2': wide_area[0]['areaMm2'] if wide_area else 0, 'regions': area})

    def pad_regions(pad, z):
        if not router.layer_visible(pad, router.layers[z]):
            return []
        x1, y1, x2, y2 = router.region(rect(pad))
        found = set()
        for y in range(y1, y2 + 1):
            for x in range(x1, x2 + 1):
                point = x * router.grid, y * router.grid
                if any(router.layers[z] in s['layers'] and inside_shape(point, s) for s in pad['contactShapes']) and labels[z][y, x]:
                    found.add(int(labels[z][y, x]))
        return sorted(found)

    ground_pads = [{'pad': g['id'], 'owner': g.get('owner'), 'number': g.get('number'),
                    'topRegions': pad_regions(g, 0), 'bottomRegions': pad_regions(g, 1),
                    'nativeLayers': g['shape']['layers']} for g in router.pads if g['net'] == ground_net]
    slots = (~via_bad) & free[0] & free[1]
    transitions = []
    for v in router.vias:
        if v['net'] == ground_net:
            continue
        gx, gy = round(v['x'] / router.grid), round(v['y'] / router.grid)
        radius = math.ceil(transition_radius / MIL_MM / router.grid)
        x1, x2, y1, y2 = max(0, gx - radius), min(router.nx, gx + radius + 1), max(0, gy - radius), min(router.ny, gy + radius + 1)
        yy, xx = np.nonzero(slots[y1:y2, x1:x2])
        record = {'signalVia': v['id'], 'net': v['net'], 'xMm': v['x'] * MIL_MM, 'yMm': v['y'] * MIL_MM}
        if len(xx):
            xx, yy = xx + x1, yy + y1
            distances = (xx * router.grid - v['x']) ** 2 + (yy * router.grid - v['y']) ** 2
            j = int(np.argmin(distances))
            nearest = math.sqrt(float(distances[j])) * MIL_MM
            if nearest <= transition_radius:
                record.update(potentialGroundViaDistanceMm=nearest, slotMm=[float(xx[j] * router.grid * MIL_MM), float(yy[j] * router.grid * MIL_MM)],
                              topRegion=int(labels[0][yy[j], xx[j]]), bottomRegion=int(labels[1][yy[j], xx[j]]))
        record['slotFoundWithinRadius'] = 'slotMm' in record
        transitions.append(record)
    projected = []
    for n in data['nets']:
        sampled, available, largest = 0, 0, 0
        for s in (s for s in router.wires if s['net'] == n['net']):
            distance = math.hypot(s['x2'] - s['x1'], s['y2'] - s['y1'])
            count, z = max(2, math.ceil(distance / projection_step)), 1 - router.layers.index(s['layer'])
            for fraction in np.linspace(0, 1, count):
                x = round((s['x1'] + (s['x2'] - s['x1']) * fraction) / router.grid)
                y = round((s['y1'] + (s['y2'] - s['y1']) * fraction) / router.grid)
                if 0 <= x < router.nx and 0 <= y < router.ny:
                    sampled += 1
                    available += bool(free[z, y, x])
                    largest += labels[z][y, x] == 1
        if sampled:
            projected.append({'net': n['net'], 'samples': sampled, 'oppositeLayerAvailableFraction': available / sampled, 'oppositeLayerLargestRegionFraction': largest / sampled})
    claimed_connected = sum(n.get('status') in ['candidate-connected', 'preserved-connected'] for n in (candidate or {}).get('nets', []))
    report = {'status': 'offline-ground-capacity-study', 'sourceCopperVias': len(router.vias),
        'sourceClaimedConnectedNonGroundNets': claimed_connected, 'sourceConnectivityVerifiedByModel': False,
        'gridMil': router.grid, 'ordinaryClearanceMil': data['clearanceMil'], 'wholeCellGuardMil': guard * router.grid,
        'coreWidthBenchmarkMil': core_width, 'transitionRadiusMm': transition_radius,
        'layers': records, 'groundPads': ground_pads,
        'knownThroughGroundPads': sum(all(l in g['nativeLayers'] for l in router.layers) for g in ground_pads),
        'signalTransitions': transitions, 'transitionSlotsMissingWithinRadius': sum(not v['slotFoundWithinRadius'] for v in transitions),
        'oppositeLayerProjection': projected, 'groundCopperCreated': False, 'groundConnectivityVerified': False,
        'returnPathsVerified': False, 'nativeDrcRun': False, 'nativeWrites': 0,
        'scope': 'sampled potential copper space; core width and transition search radius are diagnostic parameters, not newly imposed design rules; no native pour, thermal, current or return-path proof',
        'wallSeconds': time.monotonic() - began}
    arrays = {'free': free, 'topLabels': labels[0], 'bottomLabels': labels[1], 'slots': slots, 'core': np.stack(cores)}
    graph = ground_graph(data, report, arrays, router.vias)
    return report, graph, arrays


def ground_graph(data, space, arrays, copper_vias):
    config, grid = data.get('ground', {}), data['gridMil']
    top, bottom, slots = arrays['topLabels'], arrays['bottomLabels'], arrays['slots']
    offset = int(top.max())
    count = offset + int(bottom.max()) + 1
    parent = list(range(count))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[b] = a
    terminals, unrepresented = [], []
    for g in space['groundPads']:
        nodes = g['topRegions'] + [offset + b for b in g['bottomRegions']]
        if not nodes:
            unrepresented.append(g)
            continue
        for n in nodes[1:]:
            union(nodes[0], n)
        terminals.append((g, nodes[0]))
    yy, xx = np.nonzero(slots)
    a, b = top[yy, xx], offset + bottom[yy, xx]
    pairs = a.astype(np.int64) * count + b
    valid = (a > 0) & (b > offset)
    xx, yy, pairs = xx[valid], yy[valid], pairs[valid]
    distance, signal = np.full(len(xx), np.inf), np.full(len(xx), np.inf)
    ground_net = config.get('net', 'GND')
    for g in data['pads']:
        if g['net'] == ground_net:
            gx = g.get('x', (g['bbox']['minX'] + g['bbox']['maxX']) / 2)
            gy = g.get('y', (g['bbox']['minY'] + g['bbox']['maxY']) / 2)
            distance = np.minimum(distance, (xx * grid - gx) ** 2 + (yy * grid - gy) ** 2)
    for v in copper_vias:
        if v['net'] != ground_net:
            signal = np.minimum(signal, (xx * grid - v['x']) ** 2 + (yy * grid - v['y']) ** 2)
    weight = config.get('graphSignalDistanceWeight', .25)
    if not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight < 0:
        raise ValueError('PREROUTE_INPUT:ground.graphSignalDistanceWeight')
    cost = np.sqrt(np.where(np.isfinite(distance), distance, 0)) + weight * np.sqrt(np.where(np.isfinite(signal), signal, 0))
    order = np.lexsort((cost, pairs))
    _, indices = np.unique(pairs[order], return_index=True)
    best, edges, seen = order[indices], [], set()
    for j in best:
        a, b = divmod(int(pairs[j]), count)
        a, b = find(a), find(b)
        key = tuple(sorted([a, b]))
        if a == b or key in seen:
            continue
        seen.add(key)
        x, y = int(xx[j]) * grid, int(yy[j]) * grid
        edges.append({'a': a, 'b': b, 'xMil': x, 'yMil': y, 'xMm': x * MIL_MM, 'yMm': y * MIL_MM, 'cost': int(round(float(cost[j]) * 100))})
    layer_ids = data.get('routing', {}).get('layerIds', DEFAULT_ROUTING['layerIds'])
    root_config = config.get('graphRoot', {'layer': layer_ids[1], 'region': 1})
    root_layer, root_region = root_config.get('layer'), root_config.get('region')
    if root_layer not in layer_ids or not isinstance(root_region, int) or root_region < 1:
        raise ValueError('PREROUTE_INPUT:ground.graphRoot')
    root_max = int(top.max()) if root_layer == layer_ids[0] else int(bottom.max())
    root = find(root_region + (0 if root_layer == layer_ids[0] else offset)) if root_region <= root_max else None
    adjacency = {}
    for e in edges:
        adjacency.setdefault(e['a'], []).append(e['b'])
        adjacency.setdefault(e['b'], []).append(e['a'])
    reachable = {root} if root is not None else set()
    queue = deque(reachable)
    while queue:
        for n in adjacency.get(queue.popleft(), []):
            if n not in reachable:
                reachable.add(n)
                queue.append(n)
    blocked = [g for g, n in terminals if find(n) not in reachable] + unrepresented
    report = {'status': 'ground-space-graph-not-fully-connectable' if blocked or root is None else 'ground-space-graph-ready',
        'sourceSignalVias': sum(v['net'] != ground_net for v in copper_vias),
        'groundPads': len(space['groundPads']), 'potentialReachableGroundPads': len(space['groundPads']) - len(blocked),
        'blockedGroundPads': [{'id': g['pad'], 'owner': g['owner'], 'number': g['number']} for g in blocked],
        'candidatePlaneLinks': len(edges), 'plannedVias': [], 'root': root_config,
        'groundCopperCreated': False, 'groundConnectivityVerified': False, 'returnPathsVerified': False, 'nativeWrites': 0,
        'continuousSpaceInfeasibilityProven': False,
        'scope': 'conditional graph of conservative sampled top/bottom potential copper and declared pad layer spans; graph unreachability does not prove continuous-space infeasibility; planned sites are not native ground or current/thermal proof'}
    if not blocked and root is not None and config.get('optimizePlaneLinks', True):
        max_seconds, workers = config.get('graphMaxSeconds', 15), config.get('graphWorkers', 8)
        if not isinstance(max_seconds, (int, float)) or not math.isfinite(max_seconds) or max_seconds <= 0 or not isinstance(workers, int) or workers < 1:
            raise ValueError('PREROUTE_INPUT:ground.graphMaxSeconds-or-graphWorkers')
        from ortools.sat.python import cp_model
        model = cp_model.CpModel()
        amount = Counter(find(n) for g, n in terminals)
        total = sum(amount.values()) - amount[root]
        flow, chosen, nodes = {}, [], set(amount) | set(adjacency) | {root}
        for i, e in enumerate(edges):
            used, ab, ba = model.new_bool_var('via' + str(i)), model.new_int_var(0, total, 'ab' + str(i)), model.new_int_var(0, total, 'ba' + str(i))
            model.add(ab + ba <= total * used)
            chosen.append(used)
            flow.setdefault(e['a'], []).extend([ba, -ab])
            flow.setdefault(e['b'], []).extend([ab, -ba])
        for n in nodes:
            model.add(sum(flow.get(n, [])) == (-total if n == root else amount[n]))
        dominance = sum(e['cost'] for e in edges) + 1
        model.minimize(sum(v * (dominance + e['cost']) for v, e in zip(chosen, edges)))
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = max_seconds
        solver.parameters.num_search_workers = workers
        began = time.monotonic()
        status = solver.solve(model)
        report.update(optimizationStatus=solver.status_name(status), wallSeconds=time.monotonic() - began)
        if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
            _, via = routing_config(data)
            report.update(plannedVias=[{**e, 'id': 'planned-ground-via-' + str(i), 'net': ground_net, 'diameter': via['diameterMil'],
                'hole': via['holeMil'], 'layers': layer_ids[:]} for i, e in enumerate(edges) if solver.value(chosen[i])],
                optimalForPotentialGraph=status == cp_model.OPTIMAL)
    return report
