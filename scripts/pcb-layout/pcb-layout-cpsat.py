#!/usr/bin/env python3
"""Internal JSON/stdio CP-SAT backend. Geometry, rules and scoring stay in JS."""
import itertools
import json
import math
import random
import sys
import time

try:
    import ortools
    from ortools.sat.python import cp_model, cp_model_helper
except ImportError:
    print(json.dumps({"error": "CPSAT_RUNTIME_MISSING: install compatible ortools in the configured Python environment"}), file=sys.stderr)
    raise SystemExit(2)


def solve(data):
    if data.get("schemaVersion") != 1 or data.get("kind") != "flitrealize-cpsat-problem":
        raise ValueError("CPSAT_INVALID_PROBLEM")
    settings, board = data["settings"], data["board"]
    unit = settings["resolutionMil"]
    if not math.isfinite(unit) or unit < 1e-6 or unit > 5:
        raise ValueError("CPSAT_INVALID_RESOLUTION")
    if data.get("openPlacement") and (not math.isfinite(data.get("computationalCoordinateMil", 0)) or data.get("computationalCoordinateMil", 0) <= 0):
        raise ValueError("CPSAT_INVALID_OPEN_COORDINATE_DOMAIN")
    pose_dedup = data.get("poseDedupMil", unit)
    solution_limit = data.get("maxStoredSolutions", 40)
    if not math.isfinite(pose_dedup) or pose_dedup <= 0 or not isinstance(solution_limit, int) or solution_limit < 1:
        raise ValueError("CPSAT_INVALID_CANDIDATE_STORAGE")
    epsilon = max(1e-7*unit, data.get("numericToleranceMil", 0))
    floor = lambda n: math.floor((n + epsilon) / unit)
    ceil = lambda n: math.ceil((n - epsilon) / unit)
    nearest = lambda n: round(n / unit)
    model = cp_model.CpModel()
    entities = {e["ref"]: e for e in data["entities"]}
    if not entities or len(entities) != len(data["entities"]):
        raise ValueError("CPSAT_ENTITY_IDENTITY")
    magnitude = max((abs(v) for v in board.values()),default=0)
    for e in entities.values():
        magnitude = max(magnitude, *(abs(v) for v in e["base"].values()))
        for v in e["variants"]:
            magnitude = max(magnitude, *(abs(n) for n in v["boardBox"].values()))
    bound = max(1000, ceil(magnitude + 1) * 20 * (len(entities) + 1))
    if bound > 10**12:
        raise ValueError("CPSAT_INTEGER_RANGE_TOO_LARGE")
    serial = itertools.count()
    shape_random = random.Random(settings["seed"])
    var = lambda lo=-bound, hi=bound: model.new_int_var(lo, hi, f"v{next(serial)}")
    boolean = lambda: model.new_bool_var(f"b{next(serial)}")

    def expression_bounds(expression):
        # Exact affine interval arithmetic over the declared variable domains.
        # FlatIntExpr combines repeated variables, so a coordinate cancels in
        # rectangle sizes. These bounds remove no feasible model assignments.
        if isinstance(expression, int):
            return expression, expression
        flat = cp_model_helper.FlatIntExpr(expression)
        lower = upper = int(flat.offset)
        for v, coefficient in zip(flat.vars, flat.coeffs):
            lo, hi = v.domain.min(), v.domain.max()
            lower += coefficient * (lo if coefficient >= 0 else hi)
            upper += coefficient * (hi if coefficient >= 0 else lo)
        return int(lower), int(upper)

    def element(index, values):
        if min(values) == max(values):
            return values[0]
        out = var(min(values), max(values))
        model.add_element(index, values, out)
        return out

    def absolute(expression):
        lo, hi = expression_bounds(expression)
        out = var(0 if lo <= 0 <= hi else min(abs(lo), abs(hi)), max(abs(lo), abs(hi)))
        model.add_abs_equality(out, expression)
        return out

    def maximum(expressions):
        bounds = [expression_bounds(e) for e in expressions]
        out = var(max(b[0] for b in bounds), max(b[1] for b in bounds))
        model.add_max_equality(out, expressions)
        return out

    def minimum(expressions):
        if not expressions:
            raise ValueError("CPSAT_EMPTY_GEOMETRY")
        if len(expressions) == 1:
            return expressions[0]
        bounds = [expression_bounds(e) for e in expressions]
        out = var(min(b[0] for b in bounds), min(b[1] for b in bounds))
        model.add_min_equality(out, expressions)
        return out

    objective, movements, states = [], [], {}
    for ref, e in entities.items():
        variants = e["variants"]
        if not variants:
            raise ValueError("CPSAT_NO_VARIANTS " + ref)
        choice = var(0, len(variants) - 1)
        if data.get("searchFirstVariantOnly", False) and not data.get("openPlacement"):
            possible = []
            for i, v in enumerate(variants):
                legal = True
                for axis, suffix in (("x","X"),("y","Y")):
                    base = e["base"][axis] + v.get("originOffset",{}).get(axis,0)
                    lo, hi = ceil(board["min"+suffix]-base-v["boardBox"]["min"+suffix]), floor(board["max"+suffix]-base-v["boardBox"]["max"+suffix])
                    if e["fixed"]:
                        lo, hi = max(lo,0), min(hi,0)
                    edge = v.get("edge")
                    if edge and edge["key"].endswith(suffix):
                        target = board[edge["key"]]-edge["offset"]-base
                        if edge["sign"] < 0:
                            lo, hi = max(lo,ceil(target)), min(hi,floor(target+edge["maxInsetMil"]))
                        else:
                            lo, hi = max(lo,ceil(target-edge["maxInsetMil"])), min(hi,floor(target))
                    if data.get("nativeBoardEdgeMil") is not None:
                        gap = ceil(data["nativeBoardEdgeMil"])
                        for pad in v["views"]["pads"]:
                            lo = max(lo,ceil(board["min"+suffix])+gap-floor(base+pad["min"+suffix]))
                            hi = min(hi,floor(board["max"+suffix])-gap-ceil(base+pad["max"+suffix]))
                    legal &= lo <= hi
                if legal:
                    possible.append(i)
            if not possible:
                return {"status":"INFEASIBLE","sourceHash":data["sourceHash"],"solver":{"reason":"no individually feasible shape","ref":ref}}
            model.add(choice == shape_random.choice(possible) if data.get("randomFeasibleShapes",False) else choice == possible[0])
        active = [boolean() for _ in variants]
        model.add_exactly_one(active)
        for index, b in enumerate(active):
            model.add(choice == index).only_enforce_if(b)
        coords = {}
        for axis, suffix in (("x", "X"), ("y", "Y")):
            if data.get("openPlacement"):
                lower,upper=-ceil(data["computationalCoordinateMil"]),ceil(data["computationalCoordinateMil"])
            else:
                lower = min(ceil(board["min" + suffix] - e["base"][axis] - v.get("originOffset", {}).get(axis, 0) - v["boardBox"]["min" + suffix]) for v in variants)
                upper = max(floor(board["max" + suffix] - e["base"][axis] - v.get("originOffset", {}).get(axis, 0) - v["boardBox"]["max" + suffix]) for v in variants)
            if e["fixed"]:
                lower = upper = 0
            if lower > upper:
                return {"status": "INFEASIBLE", "sourceHash": data["sourceHash"], "solver": {"reason": "empty coordinate domain", "ref": ref}}
            delta = var(lower, upper)
            coords[axis] = delta
            if not data.get("noInitialHints", False):
                model.add_hint(delta, min(upper, max(lower, 0)))
            for index, v in enumerate(variants):
                base = e["base"][axis] + v.get("originOffset", {}).get(axis, 0)
                if not data.get("openPlacement"):
                    model.add(delta >= ceil(board["min" + suffix] - base - v["boardBox"]["min" + suffix])).only_enforce_if(active[index])
                    model.add(delta <= floor(board["max" + suffix] - base - v["boardBox"]["max" + suffix])).only_enforce_if(active[index])
                radius = e.get("radiusMil")
                if radius is not None:
                    offset = v.get("originOffset", {}).get(axis, 0)
                    model.add(delta >= ceil(-radius-offset)).only_enforce_if(active[index])
                    model.add(delta <= floor(radius-offset)).only_enforce_if(active[index])
                edge = v.get("edge")
                if edge and edge["key"].endswith(suffix):
                    target = board[edge["key"]] - edge["offset"] - base
                    if edge["sign"] < 0:
                        model.add(delta >= ceil(target)).only_enforce_if(active[index])
                        model.add(delta <= floor(target+edge["maxInsetMil"])).only_enforce_if(active[index])
                    else:
                        model.add(delta >= ceil(target-edge["maxInsetMil"])).only_enforce_if(active[index])
                        model.add(delta <= floor(target)).only_enforce_if(active[index])
            movement = absolute(delta)
            movements.append(movement)
            objective.append(settings["displacementWeight"] * unit / max(1, len(entities)) * movement)
        if not data.get("noInitialHints", False):
            model.add_hint(choice, e.get("preferredVariant",0))
        states[ref] = {"entity": e, "choice": choice, "active": active, **coords}

    if data.get("translationGaugeRef"):
        # Isolated block coordinates have arbitrary global translation.
        # This sets a display origin, not a location on the original PCB.
        s=states[data["translationGaugeRef"]]
        model.add(s["x"]==0);model.add(s["y"]==0)

    boxes, points = {}, {}

    def box(ref, kind, index=0):
        key = (ref, kind, index)
        if key in boxes:
            return boxes[key]
        s = states[ref]
        variants = s["entity"]["variants"]
        def shape(v):
            if kind.startswith("zone:"):
                return v["zones"][kind[5:]]
            if kind in ("body", "bundle", "physical", "courtyard"):
                return v[kind]
            return v["views"][kind][index]
        out = {}
        for axis, suffix in (("x", "X"), ("y", "Y")):
            for prefix, quantize in (("min", floor), ("max", ceil)):
                k = prefix + suffix
                values = [quantize(s["entity"]["base"][axis] + v.get("originOffset", {}).get(axis, 0) + shape(v)[k]) for v in variants]
                lo, hi = expression_bounds(s[axis])
                out[k] = var(lo + min(values), hi + max(values))
                model.add(out[k] == s[axis] + element(s["choice"], values))
        boxes[key] = out
        return out

    def view(ref, kind):
        if kind in ("body", "bundle"):
            return [box(ref, kind)]
        variants = states[ref]["entity"]["variants"]
        counts = {len(v["views"].get(kind, [])) for v in variants}
        if len(counts) != 1:
            raise ValueError("CPSAT_INCONSISTENT_VIEW " + ref + "/" + kind)
        return [box(ref, kind, i) for i in range(next(iter(counts)))]

    def point(endpoint=None, ref=None):
        ref = ref or endpoint["ref"]
        identity = endpoint["id"] if endpoint else None
        geometry = endpoint.get("geometry","anchor") if endpoint else "origin"
        key = (ref, identity, geometry)
        if key in points:
            return points[key]
        s = states[ref]
        result = {}
        for axis in "xy":
            values = [s["entity"]["base"][axis] + v.get("originOffset", {}).get(axis, 0) + (v["padCenters" if geometry=="bbox-center" else "pads"][identity][axis] if identity else 0) for v in s["entity"]["variants"]]
            result[axis] = s[axis] + element(s["choice"], [nearest(n) for n in values])
            result[axis+"Error"] = max(abs(n-nearest(n)*unit) for n in values)
        points[key] = result
        return result

    def gaps(a, b):
        return [b["minX"]-a["maxX"], a["minX"]-b["maxX"], b["minY"]-a["maxY"], a["minY"]-b["maxY"]]

    def apart(a, b, gap=0, extra=None):
        choices = [boolean() for _ in range(4)]
        model.add_bool_or(choices)
        for i, expr in enumerate(gaps(a, b)):
            model.add(expr >= gap).only_enforce_if(choices[i])
            if extra:
                model.add(extra[i] >= 0).only_enforce_if(choices[i])

    # Global rectangle propagation supplements directional pair requirements.
    # Clearance belongs to copper/placement separation, not the board margin.
    def no_overlap(kind, padding=0):
        xs, ys = [], []
        for ref in entities:
            if data.get("variantIntervals", False):
                s, e = states[ref], entities[ref]
                grouped = {}
                for i, v in enumerate(e["variants"]):
                    geometry = tuple((floor(e["base"][axis.lower()] + v.get("originOffset", {}).get(axis.lower(), 0) + v[kind]["min"+axis]),
                                      ceil(e["base"][axis.lower()] + v.get("originOffset", {}).get(axis.lower(), 0) + v[kind]["max"+axis])) for axis in "XY")
                    grouped.setdefault(geometry, []).append(i)
                for geometry, indices in grouped.items():
                    presence = s["active"][indices[0]] if len(indices) == 1 else boolean()
                    if len(indices) > 1:
                        model.add(sum(s["active"][i] for i in indices) == presence)
                    intervals = []
                    for axis, (lo, hi) in zip("xy", geometry):
                        intervals.append(model.new_optional_interval_var(s[axis]+lo, hi-lo+padding, s[axis]+hi+padding, presence, f"r{next(serial)}"))
                    xs.append(intervals[0]); ys.append(intervals[1])
                continue
            b = box(ref, kind)
            intervals = []
            for axis in "XY":
                s = states[ref]
                e = s["entity"]
                values = [ceil(e["base"][axis.lower()] + v.get("originOffset", {}).get(axis.lower(), 0) + v[kind]["max"+axis])
                          - floor(e["base"][axis.lower()] + v.get("originOffset", {}).get(axis.lower(), 0) + v[kind]["min"+axis]) + padding
                          for v in e["variants"]]
                size = var(min(values), max(values))
                model.add(size == b["max"+axis]-b["min"+axis]+padding)
                intervals.append(model.new_interval_var(b["min"+axis], size, b["max"+axis]+padding, f"r{next(serial)}"))
            xs.append(intervals[0]); ys.append(intervals[1])
        model.add_no_overlap_2d(xs, ys)

    global_gap = min((ceil(p["gapMil"]) for p in data["pairs"]), default=0)
    no_overlap("bundle", global_gap)
    if data["assembly"]:
        no_overlap("courtyard")
    def courtyard_covers_floor(a, b, required):
        def margin(ref, key):
            sign = -1 if key.startswith("min") else 1
            return min(sign*(v["courtyard"][key]-v["physical"][key]) for v in entities[ref]["variants"])
        return all(margin(a, ka)+margin(b, kb) >= required-1e-8 for ka,kb in
                   (("maxX","minX"),("minX","maxX"),("maxY","minY"),("minY","maxY")))
    for pair in data["pairs"]:
        a, b = pair["a"], pair["b"]
        if ceil(pair["gapMil"]) > global_gap:
            apart(box(a,"bundle"), box(b,"bundle"), ceil(pair["gapMil"]))
        if data["assembly"] and not courtyard_covers_floor(a,b,pair["physicalGapMil"]):
            apart(box(a,"physical"), box(b,"physical"), ceil(pair["physicalGapMil"]), gaps(box(a,"courtyard"), box(b,"courtyard")))

    distances = {}
    def pin_distance(left, right, conservative=False):
        values = []
        for a in left:
            for b in right:
                key = (a["id"], a.get("geometry","anchor"), b["id"], b.get("geometry","anchor"))
                if key not in distances:
                    pa, pb = point(a), point(b)
                    distance = absolute(pa["x"]-pb["x"])+absolute(pa["y"]-pb["y"])
                    error = ceil(sum(pa[k]+pb[k] for k in ("xError", "yError")))
                    distances[key] = (distance, error)
                d, error = distances[key]
                values.append(d + (error if conservative else 0))
        return minimum(values)

    for link in data["links"]:
        if link["weight"]:
            objective.append(unit*link["weight"]*pin_distance(link["left"], link["right"]))
    for limit in data["limits"]:
        model.add(pin_distance(limit["left"], limit["right"], True) <= floor(limit["maxMil"]))
    for net in data["nets"]:
        if not net["weight"]:
            continue
        endpoints = [point(p) for p in net["pads"]]
        length = sum(maximum([p[a] for p in endpoints])-minimum([p[a] for p in endpoints]) for a in "xy")
        objective.append(unit*net["weight"]*length)

    def origin_distance(ref, anchors):
        p, n = point(ref=ref), len(anchors)
        peers = [point(ref=r) for r in anchors]
        d = sum(absolute(n*p[a]-sum(q[a] for q in peers)) for a in "xy")
        error = ceil(sum(n*p[a+"Error"]+sum(q[a+"Error"] for q in peers) for a in "xy"))
        return d, n, error

    for rule in data["blocks"]:
        d, multiplier, error = origin_distance(rule["ref"], rule["anchors"])
        model.add(d+error <= floor(rule["maxDistanceMil"]*multiplier))
    for rule in data["relations"]:
        band = rule["band"]
        if "hardMinMil" not in band and "hardMaxMil" not in band:
            continue  # These preferences remain observations in simple-v1.
        if rule["metric"] == "origin-manhattan":
            d, multiplier, error = origin_distance(rule["a"], rule["anchors"])
            if "hardMinMil" in band:
                model.add(d-error >= ceil(band["hardMinMil"]*multiplier))
        else:
            ka = {"body-gap":"body", "bundle-gap":"bundle"}.get(rule["metric"], rule.get("geometryA"))
            kb = {"body-gap":"body", "bundle-gap":"bundle"}.get(rule["metric"], rule.get("geometryB"))
            left, right = view(rule["a"],ka), view(rule["anchors"][0],kb)
            if not left or not right:
                raise ValueError("CPSAT_RELATION_GEOMETRY_MISSING " + rule["id"])
            d = minimum([maximum(gaps(a,b)) for a in left for b in right])
            multiplier, error = 1, 2
            if "hardMinMil" in band:
                model.add(d >= ceil(band["hardMinMil"]))
        if "hardMaxMil" in band:
            model.add(d+error <= floor(band["hardMaxMil"]*multiplier))

    for zone in data["zones"]:
        zb = box(zone["owner"], "zone:"+zone["id"]) if zone.get("owner") else {k:(floor(v) if k.startswith("min") else ceil(v)) for k,v in zone["box"].items()}
        required = set(zone.get("targetRefs", [r for r,e in entities.items() if e["kind"]=="component"]))-set(zone["excludeRefs"])
        refs = [r for r in entities if r not in zone["excludeRefs"] and ("targetRefs" not in zone or r in zone["targetRefs"])]
        for ref in refs:
            shapes = view(ref,zone["geometry"])
            if ref in required and not shapes:
                raise ValueError("CPSAT_ZONE_GEOMETRY_MISSING " + zone["id"]+"/"+ref)
            for index,shape in enumerate(shapes):
                if zone.get("allowedNet") is not None and zone["geometry"]=="pads":
                    pid=data["padIdsByRef"][ref][index]
                    if data["padNets"][pid]==zone["allowedNet"]:
                        continue
                apart(shape, zb)

    for pair in data["spacing"]:
        distance = maximum(gaps(box(pair["a"],"physical"), box(pair["b"],"physical")))
        penalty = maximum([0, ceil(pair["minMil"])-distance, distance-floor(pair["maxMil"])])
        objective.append(unit*pair["weight"]*penalty)
    semantic_terms = []
    for group in data.get("semanticGroups", []):
        if len(group["members"]) < 2 or group["normalizedWeight"] == 0:
            continue
        shapes = [box(ref, "physical") for ref in group["members"]]
        span = (maximum([b["maxX"] for b in shapes])-minimum([b["minX"] for b in shapes])
                + maximum([b["maxY"] for b in shapes])-minimum([b["minY"] for b in shapes]))
        semantic_terms.append(unit*group["normalizedWeight"]/group["referenceMil"]*span)
    if data.get("nativeBoardEdgeMil") is not None:
        gap = ceil(data["nativeBoardEdgeMil"])
        for ref in entities:
            for pad_box in view(ref, "pads"):
                model.add(pad_box["minX"] >= ceil(board["minX"])+gap)
                model.add(pad_box["maxX"] <= floor(board["maxX"])-gap)
                model.add(pad_box["minY"] >= ceil(board["minY"])+gap)
                model.add(pad_box["maxY"] <= floor(board["maxY"])-gap)
    model.minimize(sum(objective)+sum(semantic_terms))
    if data.get("localSearchRegion"):
        region=data["localSearchRegion"]
        for ref in region["refs"]:
            for kind in ("physical","bundle"):
                b=box(ref,kind)
                for axis in "XY":
                    model.add(b["min"+axis]>=ceil(region["box"]["min"+axis]))
                    model.add(b["max"+axis]<=floor(region["box"]["max"+axis]))
    for side in data.get("componentSideRules",[]):
        for key in ["minX","maxX","minY","maxY"]:
            field=key[:3]+"Body"+key[3:]+"Mil"
            if field in side:
                if key.startswith("min"):model.add(box(side["ref"],"physical")[key]>=ceil(side[field]))
                else:model.add(box(side["ref"],"physical")[key]<=floor(side[field]))
    for rule in data.get("bodyCoordinateBounds",[]):
        expr=box(rule["ref"],"physical")[rule["key"]]
        model.add(expr>=ceil(rule["minimumMil"]))
        model.add(expr<=floor(rule["maximumMil"]))
    critical_distances=[pin_distance(p["left"],p["right"]) for p in data.get("criticalPairs",[])]
    all_block_pairs={p["id"]:p for p in data.get("criticalPairs",[])+data.get("boundaryPairs",[])}
    for cap in data.get("baselineDistanceCaps",[]):
        p=all_block_pairs[cap["id"]]
        model.add(pin_distance(p["left"],p["right"])<=floor(cap["maxMil"]))
    critical_worst=maximum(critical_distances) if critical_distances else None
    if data.get("criticalWorstCapMil") is not None:
        model.add(critical_worst<=floor(data["criticalWorstCapMil"]))
    policy=data.get("blockObjective")
    if policy=="critical-worst":
        model.minimize(critical_worst)
    elif policy=="electrical-only":
        critical_cost=sum(p.get("weight",1)*d for p,d in zip(data["criticalPairs"],critical_distances))
        boundary_cost=sum(p["weight"]*pin_distance(p["left"],p["right"]) for p in data.get("boundaryPairs",[]))
        flows=[]
        for rule in data.get("routingFlowRules",[]):
            owner=states[rule["owner"]];target=point(rule["endpoint"])
            loss=var(0,bound)
            for i,v in enumerate(owner["entity"]["variants"]):
                direction=rule["orientations"][str(v["rotation"])]
                axis=direction["axis"]
                model.add(loss>=direction["sign"]*(owner[axis]+nearest(direction["offsetMil"])-target[axis])).only_enforce_if(owner["active"][i])
            flows.append(rule["weight"]*loss)
        model.minimize(unit*(critical_cost+boundary_cost+sum(flows)))
    elif policy=="critical-total-and-boundaries":
        peers=[p["weight"]*pin_distance(p["left"],p["right"]) for p in data.get("boundaryPairs",[])]
        shapes=[box(ref,"physical") for ref in data["localSearchRegion"]["refs"]]
        span=(maximum([b["maxX"] for b in shapes])-minimum([b["minX"] for b in shapes])
              +maximum([b["maxY"] for b in shapes])-minimum([b["minY"] for b in shapes]))
        model.minimize(unit*(sum(critical_distances)+sum(peers)+data.get("blockCompactnessWeight",0)*span))
    if data.get("feasibilityOnly", False):
        model.clear_objective()
    validation = model.validate()
    if validation:
        raise ValueError("CPSAT_MODEL_INVALID " + validation)
    solver = cp_model.CpSolver()
    if data.get("geometryDecisionStrategy", False):
        ordered = sorted(states.values(), key=lambda s: -max((v["physical"]["maxX"]-v["physical"]["minX"])*(v["physical"]["maxY"]-v["physical"]["minY"]) for v in s["entity"]["variants"]))
        model.add_decision_strategy([v for s in ordered for v in (s["choice"],s["x"],s["y"])], cp_model.CHOOSE_FIRST, cp_model.SELECT_MIN_VALUE)
        solver.parameters.search_branching = cp_model.PARTIAL_FIXED_SEARCH
    available = (data["deadlineEpochMs"]/1000-time.time()-.25) if "deadlineEpochMs" in data else settings["timeLimitSeconds"]
    solver.parameters.max_time_in_seconds = max(.01, min(settings["timeLimitSeconds"], available))
    solver.parameters.num_search_workers = settings["workers"]
    solver.parameters.random_seed = settings["seed"]
    if data.get("feasibilityOnly", False):
        solver.parameters.stop_after_first_solution = True

    def placements(reader):
        return [{"ref":ref,"dx":reader.value(s["x"]),"dy":reader.value(s["y"]),"variant":reader.value(s["choice"])} for ref,s in states.items()]

    def checkpoint(positions):
        print(json.dumps({"event":"incumbent","status":"FEASIBLE","sourceHash":data["sourceHash"],"placements":positions,
                          "solver":{"engineVersion":ortools.__version__,"optimalForCompiledModel":False,"solution":"checkpoint",
                                    "initialHintCount":len(model.proto.solution_hint.vars),"noInitialHints":data.get("noInitialHints",False)}}, allow_nan=False), flush=True)

    class Incumbents(cp_model.CpSolverSolutionCallback):
        def __init__(self):
            super().__init__()
            self.solutions = []
            self.pose_keys = set()
        def on_solution_callback(self):
            candidate = placements(self)
            key = tuple((p["ref"],round((entities[p["ref"]]["base"]["x"]+p["dx"]*unit+entities[p["ref"]]["variants"][p["variant"]].get("originOffset",{}).get("x",0))/pose_dedup),round((entities[p["ref"]]["base"]["y"]+p["dy"]*unit+entities[p["ref"]]["variants"][p["variant"]].get("originOffset",{}).get("y",0))/pose_dedup),entities[p["ref"]]["variants"][p["variant"]]["rotation"]) for p in candidate)
            if key in self.pose_keys:
                return
            self.pose_keys.add(key)
            self.solutions.append(candidate)
            checkpoint(self.solutions[-1])
            if len(self.solutions)>solution_limit:
                self.solutions.pop(0)
    callback = Incumbents()
    feasibility = None
    if len(entities) >= 24 and not data.get("noInitialHints", False) and not data.get("skipFeasibilityPhase", False):
        # First obtain a complete legal assignment; optimization reuses it as
        # a hint. This changes search effort, never the engineering constraints.
        total_seconds = solver.parameters.max_time_in_seconds
        first_model = model.clone()
        first_model.minimize(sum(movements))
        for ref,s in states.items():
            e = s["entity"]
            rotation = e["variants"][e.get("preferredVariant",0)]["rotation"]
            first_model.add_allowed_assignments([s["choice"]], [[i] for i,v in enumerate(e["variants"]) if v["rotation"]==rotation])
        solver.parameters.max_time_in_seconds = min(5, total_seconds * .25)
        solver.parameters.stop_after_first_solution = True
        # Keep default hint handling: repair_hint can assert in the pinned
        # multi-worker runtime (google/or-tools issue 5025).
        first_status = solver.solve(first_model)
        feasibility = {"status":solver.status_name(first_status),"wallSeconds":solver.wall_time,"scope":"input rotations; full rotation domain is restored for optimization"}
        if first_status in (cp_model.OPTIMAL,cp_model.FEASIBLE):
            callback.solutions.append(placements(solver))
            checkpoint(callback.solutions[-1])
            model.clear_hints()
            for i in range(len(model.proto.variables)):
                v = model.get_int_var_from_proto_index(i)
                model.add_hint(v,solver.value(v))
        solver.parameters.stop_after_first_solution = False
        solver.parameters.max_time_in_seconds = max(.01, total_seconds-feasibility["wallSeconds"])
    hint_count = len(model.proto.solution_hint.vars)
    if data.get("noInitialHints", False) and hint_count:
        raise ValueError("UNEXPECTED_INITIAL_HINTS")
    generated = data.get("generatedCheckpointPlacements", [])
    if generated:
        if len(generated) != len(states) or len({p['ref'] for p in generated}) != len(states):
            raise ValueError("INVALID_GENERATED_CHECKPOINT")
        for p in generated:
            s = states[p['ref']]
            model.add_hint(s['x'], p['dx'])
            model.add_hint(s['y'], p['dy'])
            model.add_hint(s['choice'], p['variant'])
    generated_hint_count = len(model.proto.solution_hint.vars) - hint_count
    cpu_started = time.process_time()
    status = solver.solve(model, callback)
    process_cpu_seconds = time.process_time()-cpu_started
    result = {"status":solver.status_name(status),"sourceHash":data["sourceHash"],"solver":{
        "engineVersion":ortools.__version__,"wallSeconds":solver.wall_time,"processCpuSeconds":process_cpu_seconds,"workers":settings["workers"],"branches":solver.num_branches,"conflicts":solver.num_conflicts,
        "variables":len(model.proto.variables),"constraints":len(model.proto.constraints),"resolutionMil":unit,"solverTimeBudgetSeconds":solver.parameters.max_time_in_seconds,
        "objectiveScope":"compiled electrical objective plus source-derived physical-group compactness; independent JS quality score",
        "initialHintCount":hint_count,"externalInitialHintCount":hint_count,"internallyGeneratedHintCount":generated_hint_count,"noInitialHints":data.get("noInitialHints",False),
        "semanticGroupCount":len(data.get("semanticGroups",[]))}}
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        result.update(placements=placements(solver), solutions=callback.solutions)
        result["solver"].update(objective=solver.objective_value,bestBound=solver.best_objective_bound,optimalForCompiledModel=status==cp_model.OPTIMAL)
        if critical_worst is not None:
            result["solver"]["criticalWorstMil"]=solver.value(critical_worst)*unit
            result["solver"]["blockObjective"]=policy
    elif callback.solutions:
        # Keep the independently checkable feasible incumbent when the later
        # optimization phase reaches its limit before returning another one.
        result.update(status="FEASIBLE",placements=callback.solutions[-1],solutions=callback.solutions)
        result["solver"]["optimalForCompiledModel"] = False
    if feasibility:
        result["solver"]["feasibilityPhase"] = feasibility
    return result


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--probe"]:
            print(json.dumps({"backend":"cpsat","version":ortools.__version__}))
        else:
            print(json.dumps(solve(json.load(sys.stdin)), allow_nan=False))
    except Exception as error:
        print(json.dumps({"error":str(error)}, ensure_ascii=True), file=sys.stderr)
        raise SystemExit(2)
