#!/usr/bin/env python3
"""Rigid templates and optional FFT copper-channel prefilter; JSON stdin/stdout.

All coordinates, layers, rules, weights, rotations and anchors are input data.
Quantized packing and raster screening require the exact JS verifier afterward.
"""
import itertools
import json
import math
import sys
import time
import ortools
from ortools.sat.python import cp_model


def rotate(point, degrees):
    x, y = point
    return {0: (x, y), 90: (-y, x), 180: (-x, -y), 270: (y, -x)}[degrees]


def bounds(box, rotation):
    points = [rotate((box[x], box[y]), rotation) for x, y in (("minX", "minY"), ("minX", "maxY"), ("maxX", "minY"), ("maxX", "maxY"))]
    return dict(minX=min(p[0] for p in points), maxX=max(p[0] for p in points), minY=min(p[1] for p in points), maxY=max(p[1] for p in points))


def pack(data):
    if data.get("schemaVersion") != 1 or data.get("kind") != "flitrealize-cpsat-rigid-blocks":
        raise ValueError("INVALID_RIGID_BLOCK_PROBLEM")
    settings, board, groups = data["settings"], data["board"], data["groups"]
    unit = settings["resolutionMil"]
    floor = lambda n: math.floor(n / unit + 1e-7)
    ceil = lambda n: math.ceil(n / unit - 1e-7)
    nearest = lambda n: round(n / unit)
    magnitude = max(abs(v) for v in board.values())
    magnitude = max(magnitude, *(abs(v) for g in groups for p in g["parts"] for v in p["body"].values()))
    bound = max(1000, ceil(magnitude + 1) * 20 * (len(groups) + 1))
    if bound > 10**12:
        raise ValueError("RIGID_BLOCK_INTEGER_RANGE")
    model, serial, states, bodies = cp_model.CpModel(), itertools.count(), {}, {}
    var = lambda lo=-bound, hi=bound: model.new_int_var(lo, hi, f"v{next(serial)}")
    boolean = lambda: model.new_bool_var(f"b{next(serial)}")
    xs, ys, courtyard_xs, courtyard_ys = [], [], [], []
    for group in groups:
        ident, rotations, base = group["id"], group["rotations"], group["base"]
        x, y = var(0, 0) if group["fixed"] else var(), var(0, 0) if group["fixed"] else var()
        choice, active = var(0, len(rotations)-1), [boolean() for _ in rotations]
        model.add_exactly_one(active)
        states[ident] = dict(x=x, y=y, choice=choice, active=active, group=group)
        for j, rotation in enumerate(rotations):
            model.add(choice == j).only_enforce_if(active[j])
            for part in group["parts"]:
                shape = bounds(part["body"], rotation)
                shape = {k: n+base["x" if k.endswith("X") else "y"] for k, n in shape.items()}
                bodies.setdefault(part["ref"], (ident, []))[1].append(shape)
                margin = data["bodyGapMil"] / 2
                intervals = []
                for axis, delta in (("X", x), ("Y", y)):
                    # Monotone nearest endpoint rounding preserves rigid gaps;
                    # exact floating-point clearance is checked after solving.
                    lo, hi = nearest(shape["min"+axis]-margin), nearest(shape["max"+axis]+margin)
                    intervals.append(model.new_optional_fixed_size_interval_var(delta+lo, hi-lo, active[j], f"r{next(serial)}"))
                    model.add(delta >= ceil(board["min"+axis]-shape["min"+axis])).only_enforce_if(active[j])
                    model.add(delta <= floor(board["max"+axis]-shape["max"+axis])).only_enforce_if(active[j])
                xs.append(intervals[0]); ys.append(intervals[1])
                if part.get("courtyard"):
                    courtyard = bounds(part["courtyard"], rotation)
                    intervals = []
                    for axis, delta in (("X", x), ("Y", y)):
                        offset = base["x" if axis == "X" else "y"]
                        lo, hi = nearest(courtyard["min"+axis]+offset), nearest(courtyard["max"+axis]+offset)
                        intervals.append(model.new_optional_fixed_size_interval_var(delta+lo, hi-lo, active[j], f"c{next(serial)}"))
                    courtyard_xs.append(intervals[0]); courtyard_ys.append(intervals[1])
            for pad in group["pads"]:
                shape = bounds(pad["bbox"], rotation)
                for axis, delta in (("X", x), ("Y", y)):
                    offset = base["x" if axis == "X" else "y"]
                    model.add(delta >= ceil(board["min"+axis]+data["copperEdgeMil"]-shape["min"+axis]-offset)).only_enforce_if(active[j])
                    model.add(delta <= floor(board["max"+axis]-data["copperEdgeMil"]-shape["max"+axis]-offset)).only_enforce_if(active[j])
        allowed = group.get("allowedTransforms")
        if allowed is not None:
            model.add_allowed_assignments([x, y, choice], [[nearest(p["x"]-base["x"]), nearest(p["y"]-base["y"]), rotations.index(p["rotation"])] for p in allowed])
        cells = group.get("channelCells")
        if cells is not None:
            step = nearest(cells["gridMil"])
            if step < 1 or abs(step*unit-cells["gridMil"]) > 1e-6:
                raise ValueError("CHANNEL_GRID_NOT_MULTIPLE_OF_RESOLUTION")
            gx, gy = var(0, bound), var(0, bound)
            for delta, variable, axis in ((x, gx, "x"), (y, gy, "y")):
                coordinate = delta+nearest(base[axis]-cells["origin"][axis])
                model.add(coordinate >= 0)
                model.add_division_equality(variable, coordinate, step)
            model.add_allowed_assignments([gx, gy, choice], cells["rows"])
    model.add_no_overlap_2d(xs, ys)
    if courtyard_xs:
        model.add_no_overlap_2d(courtyard_xs, courtyard_ys)

    def coordinate(group, key, values):
        state = states[group]
        offset = var(min(values), max(values))
        model.add_element(state["choice"], values, offset)
        return state["x" if key.endswith("X") else "y"]+offset

    def body(ref):
        group, variants = bodies[ref]
        return {key: coordinate(group, key, [(floor if key.startswith("min") else ceil)(v[key]) for v in variants]) for key in ("minX", "maxX", "minY", "maxY")}

    def apart(a, b, gap):
        flags = [boolean() for _ in range(4)]
        model.add_bool_or(flags)
        for flag, expression in zip(flags, [a["minX"]-b["maxX"], b["minX"]-a["maxX"], a["minY"]-b["maxY"], b["minY"]-a["maxY"]]):
            model.add(expression >= ceil(gap)).only_enforce_if(flag)

    body_variables = {ref: body(ref) for ref in bodies}
    for a, b in itertools.combinations(bodies, 2):
        if bodies[a][0] != bodies[b][0]:
            apart(body_variables[a], body_variables[b], data["bodyGapMil"])
    for rule in data.get("separations", []):
        apart(body_variables[rule["a"]], body_variables[rule["b"]], rule["gapMil"])
    for rule in data.get("edges", []):
        # Match shared layout edge semantics: top=minY, bottom=maxY.
        state = states[bodies[rule["ref"]][0]]
        variants = rule.get("variantSides", [[rule.get("side")]]*len(state["active"]))
        for active, sides in zip(state["active"], variants):
            flags = [boolean() for _ in sides]
            model.add_bool_or(flags).only_enforce_if(active)
            for flag, side in zip(flags, sides):
                key = {"left": "minX", "right": "maxX", "top": "minY", "bottom": "maxY"}[side]
                expression = body_variables[rule["ref"]][key]
                if key.startswith("min"):
                    model.add(expression <= floor(board[key]+rule["maxInsetMil"])).only_enforce_if([active, flag])
                else:
                    model.add(expression >= ceil(board[key]-rule["maxInsetMil"])).only_enforce_if([active, flag])
    for cut in data.get("cuts", []):
        boxes = []
        for side in ("a", "b"):
            group, box = cut[side].get("group"), cut[side]["box"]
            if group is None:
                boxes.append({key: (floor if key.startswith("min") else ceil)(value) for key, value in box.items()})
                continue
            record = states[group]["group"]
            variants = [bounds(box, r) for r in record["rotations"]]
            boxes.append({key: coordinate(group, key, [(floor if key.startswith("min") else ceil)(v[key]+record["base"]["x" if key.endswith("X") else "y"]) for v in variants]) for key in box})
        apart(boxes[0], boxes[1], cut["gapMil"])
    nets = {}
    for group in groups:
        for pad in group["pads"]:
            if not pad.get("net") or pad["net"] in data["excludeNets"]:
                continue
            box = pad["bbox"]
            nets.setdefault(pad["net"], []).append((group["id"], ((box["minX"]+box["maxX"])/2, (box["minY"]+box["maxY"])/2)))
    costs = []
    for net, pins in nets.items():
        if len({g for g, p in pins}) < 2:
            continue
        points = []
        for group, point in pins:
            record = states[group]["group"]
            points.append([coordinate(group, "max"+axis.upper(), [nearest(rotate(point, r)[j]+record["base"][axis]) for r in record["rotations"]]) for j, axis in enumerate("xy")])
        spans = []
        for axis in range(2):
            hi, lo = var(), var()
            model.add_max_equality(hi, [p[axis] for p in points]); model.add_min_equality(lo, [p[axis] for p in points])
            spans.append(hi-lo)
        costs.append(sum(spans)*data["netWeights"].get(net, data["defaultNetWeight"]))
    model.minimize(sum(costs)*unit)
    if data.get("feasibilityOnly"):
        model.clear_objective()
    validation = model.validate()
    if validation:
        raise ValueError("RIGID_BLOCK_MODEL_INVALID: "+validation)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = settings["timeLimitSeconds"]
    solver.parameters.num_search_workers = settings["workers"]
    solver.parameters.random_seed = settings["seed"]
    solver.parameters.stop_after_first_solution = data.get("feasibilityOnly", False)
    started = time.time(); status = solver.solve(model)
    result = dict(status=solver.status_name(status), sourceHash=data["sourceHash"], solver=dict(engineVersion=ortools.__version__, wallSeconds=time.time()-started, optimalForCompiledModel=status == cp_model.OPTIMAL, objectiveScope="weighted cross-group HPWL proxy", copperConflictCuts=len(data.get("cuts", []))))
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        result["transforms"] = {ident: dict(x=solver.value(s["x"])*unit+s["group"]["base"]["x"], y=solver.value(s["y"])*unit+s["group"]["base"]["y"], rotation=s["group"]["rotations"][solver.value(s["choice"])]) for ident, s in states.items()}
        result["solver"].update(objective=solver.objective_value, bestBound=solver.best_objective_bound)
    return result


def filter_channels(data):
    """Rasterize preserved copper, correlate all block rotations in bulk.

    Each allowed cell is a coarse search gate. Raster approximation and any
    within-cell solver movement are deliberately rechecked by exact geometry.
    """
    import numpy as np
    policy, board = data["channelFilter"], data["board"]
    grid, layers, gap = policy["gridMil"], policy["layers"], policy["clearanceMil"]
    width, height = math.floor((board["maxX"]-board["minX"])/grid)+1, math.floor((board["maxY"]-board["minY"])/grid)+1
    fixed = np.zeros((len(layers), height, width), dtype=np.float64)

    def paint(mask, shape, origin, dilation=0):
        if shape["kind"] == "polygon":
            points = shape["points"]
            # Conservative AABB proxy matches source pad rectangle screening.
            a = (min(p[0] for p in points), min(p[1] for p in points)); b = (max(p[0] for p in points), max(p[1] for p in points))
            radius = dilation
        else:
            a = shape.get("a", shape.get("center")); b = shape.get("b", a); radius = shape.get("radius", 0)+dilation
        x0, x1 = max(0, math.floor((min(a[0], b[0])-radius-origin[0])/grid)), min(mask.shape[1]-1, math.ceil((max(a[0], b[0])+radius-origin[0])/grid))
        y0, y1 = max(0, math.floor((min(a[1], b[1])-radius-origin[1])/grid)), min(mask.shape[0]-1, math.ceil((max(a[1], b[1])+radius-origin[1])/grid))
        if x1 < x0 or y1 < y0:
            return
        x = (origin[0]+np.arange(x0, x1+1)*grid)[None, :]; y = (origin[1]+np.arange(y0, y1+1)*grid)[:, None]
        if shape["kind"] == "polygon":
            patch = (x >= a[0]-radius) & (x <= b[0]+radius) & (y >= a[1]-radius) & (y <= b[1]+radius)
        else:
            dx, dy = b[0]-a[0], b[1]-a[1]; den = dx*dx+dy*dy
            t = np.clip(((x-a[0])*dx+(y-a[1])*dy)/den, 0, 1) if den else 0
            patch = (x-a[0]-t*dx)**2+(y-a[1]-t*dy)**2 <= radius*radius
        mask[y0:y1+1, x0:x1+1] = np.maximum(mask[y0:y1+1, x0:x1+1], patch)

    origin = (board["minX"], board["minY"])
    for copper in policy["fixedCopper"]:
        shape = copper["shape"]
        for index, layer in enumerate(layers):
            if layer in shape["layers"]:
                paint(fixed[index], shape, origin, gap)
    result = {}
    for group in data["groups"]:
        if group["fixed"] or policy.get("groupIds") is not None and group["id"] not in policy["groupIds"]:
            continue
        rows = []
        for variant, rotation in enumerate(group["rotations"]):
            shapes = []
            for copper in group["copper"]:
                shape = dict(copper["shape"])
                for key in ("a", "b", "center"):
                    if key in shape: shape[key] = rotate(shape[key], rotation)
                if "points" in shape: shape["points"] = [rotate(p, rotation) for p in shape["points"]]
                shapes.append(shape)
            if not shapes:
                raise ValueError("CHANNEL_TEMPLATE_COPPER_MISSING: "+group["id"])
            boxes = []
            for shape in shapes:
                pts = shape.get("points", [shape.get("a", shape.get("center")), shape.get("b", shape.get("a", shape.get("center")))])
                radius = shape.get("radius", 0)
                boxes.append((min(p[0] for p in pts)-radius, min(p[1] for p in pts)-radius, max(p[0] for p in pts)+radius, max(p[1] for p in pts)+radius))
            ox, oy = math.floor(min(b[0] for b in boxes)/grid)-1, math.floor(min(b[1] for b in boxes)/grid)-1
            mx, my = math.ceil(max(b[2] for b in boxes)/grid)+1, math.ceil(max(b[3] for b in boxes)/grid)+1
            template = np.zeros((len(layers), my-oy+1, mx-ox+1), dtype=np.float64)
            for shape in shapes:
                for index, layer in enumerate(layers):
                    if layer in shape["layers"]: paint(template[index], shape, (ox*grid, oy*grid))
            fft_shape = (height+template.shape[1]-1, width+template.shape[2]-1)
            correlation = sum(np.fft.irfftn(np.fft.rfftn(fixed[index], fft_shape, axes=(0, 1))*np.conj(np.fft.rfftn(template[index], fft_shape, axes=(0, 1))), fft_shape, axes=(0, 1)) for index in range(len(layers)))
            top, right = height-template.shape[1]+1, width-template.shape[2]+1
            if top > 0 and right > 0:
                yy, xx = np.nonzero(correlation[:top, :right] < .5)
                rows.extend([[int(x-ox), int(y-oy), variant] for x, y in zip(xx, yy)])
        result[group["id"]] = dict(gridMil=grid, origin=dict(x=origin[0], y=origin[1]), rows=rows)
    return dict(status="channels-filtered", sourceHash=data["sourceHash"], channels=result, verification="raster search gate; exact copper checks required")


if __name__ == "__main__":
    try:
        data = json.load(sys.stdin)
        print(json.dumps(filter_channels(data) if data.get("operation") == "filter-channels" else pack(data), allow_nan=False))
    except Exception as error:
        print(json.dumps(dict(error=str(error))), file=sys.stderr)
        raise SystemExit(2)
