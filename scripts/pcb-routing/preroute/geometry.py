"""Small mil-based geometry primitives; importing performs no work."""
import math


def rect(pad):
    b = pad['bbox']
    return b['minX'], b['minY'], b['maxX'], b['maxY']


def centre(pad):
    x1, y1, x2, y2 = rect(pad)
    return (x1 + x2) / 2, (y1 + y2) / 2


def seg_rect(a, b, rectangle):
    lo, hi = 0., 1.
    for axis, mn, mx in [(0, rectangle[0], rectangle[2]), (1, rectangle[1], rectangle[3])]:
        d = b[axis] - a[axis]
        if abs(d) < 1e-12:
            if a[axis] < mn or a[axis] > mx:
                return False
        else:
            x, y = (mn - a[axis]) / d, (mx - a[axis]) / d
            lo, hi = max(lo, min(x, y)), min(hi, max(x, y))
            if lo > hi:
                return False
    return True


def point_seg(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    den = dx * dx + dy * dy
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den)) if den else 0
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def seg_gap(a, b, c, d):
    if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
        return 0
    return min(point_seg(a, c, d), point_seg(b, c, d), point_seg(c, a, b), point_seg(d, a, b))


def bbox_shape(shape):
    points = shape.get('points') or ([shape['a'], shape['b']] if shape['kind'] == 'capsule' else [shape['center']])
    radius = shape.get('radius', 0)
    return min(x for x, y in points) - radius, min(y for x, y in points) - radius, max(x for x, y in points) + radius, max(y for x, y in points) + radius


def outside_length(a, b, rectangle):
    length = math.dist(a, b)
    if not length:
        return 0
    lo, hi = 0., 1.
    for axis in range(2):
        d = b[axis] - a[axis]
        if not d:
            if not rectangle[axis] <= a[axis] <= rectangle[axis + 2]:
                return length
        else:
            x, y = (rectangle[axis] - a[axis]) / d, (rectangle[axis + 2] - a[axis]) / d
            lo, hi = max(lo, min(x, y)), min(hi, max(x, y))
    return length * (1 - max(0, hi - lo))


def inside_shape(point, shape):
    if shape['kind'] == 'capsule':
        return point_seg(point, shape['a'], shape['b']) <= shape['radius'] + 1e-6
    if shape['kind'] == 'circle':
        return math.dist(point, shape['center']) <= shape['radius'] + 1e-6
    points = shape['points']
    if any(point_seg(point, a, b) < 1e-6 for a, b in zip(points, points[1:] + points[:1])):
        return True
    result = False
    for a, b in zip(points, points[1:] + points[:1]):
        if (a[1] > point[1]) != (b[1] > point[1]) and point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result
