// Decode native outline paths here; the solver only consumes rectangular bounds.
export function decodeBoard(outlines = []) {
  if (!Array.isArray(outlines)) return { status: 'unsupported', reason: 'Outline observation is not an array.' };
  if (!outlines.length) return { status: 'none' };
  const unsupported = () => ({ status: 'unsupported', reason: 'Expected one closed axis-aligned rectangular polyline.' });
  if (outlines.length !== 1) return unsupported();
  const path = outlines[0].path;
  if (!Array.isArray(path) || path.length < 8) return unsupported();
  const tokens = [...path], points = [];
  if (tokens[0] === 'M') tokens.shift();
  let closed = false;
  while (tokens.length) {
    if (tokens[0] === 'Z') { tokens.shift(); if (tokens.length) return unsupported(); closed = true; break; }
    if (tokens[0] === 'L') { if (!points.length) return unsupported(); tokens.shift(); }
    const x = tokens.shift(), y = tokens.shift();
    if (!Number.isFinite(x) || !Number.isFinite(y)) return unsupported();
    points.push({ x, y });
  }
  const eq = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  if (points.length > 1 && eq(points[0], points.at(-1))) { points.pop(); closed = true; }
  if (!closed) return unsupported();
  let changed = true;
  while (changed && points.length > 4) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length];
      if ((a.x === b.x && b.x === c.x && (b.y - a.y) * (c.y - b.y) >= 0)
        || (a.y === b.y && b.y === c.y && (b.x - a.x) * (c.x - b.x) >= 0)) { points.splice(i, 1); changed = true; break; }
    }
  }
  if (points.length !== 4 || new Set(points.map(p => p.x + ',' + p.y)).size !== 4) return unsupported();
  const xs = [...new Set(points.map(p => p.x))], ys = [...new Set(points.map(p => p.y))];
  if (xs.length !== 2 || ys.length !== 2 || points.some((p, i) => { const q = points[(i + 1) % 4]; return p.x !== q.x && p.y !== q.y; })) return unsupported();
  return { status: 'rectangle', bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } };
}
