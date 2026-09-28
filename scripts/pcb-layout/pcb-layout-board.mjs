// Pure rectangular-board geometry, shared with independent native verification.
export function boardRuntime() {
  const keys = ['minX', 'minY', 'maxX', 'maxY'], eps = .001;
  const valid = b => b && typeof b === 'object' && !Array.isArray(b)
    && Object.keys(b).every(k => keys.includes(k)) && keys.every(k => Number.isFinite(b[k]))
    && b.maxX > b.minX && b.maxY > b.minY;
  const fail = code => { throw Object.assign(Error(code), { code }); };
  const same = (a, b) => keys.every(k => Math.abs(a[k] - b[k]) <= eps);
  function resolveBoardBounds(native, configured = null, mechanical = null) {
    if (configured != null && !valid(configured)) fail('INVALID_BOARD_BOUNDS');
    if (mechanical != null && !valid(mechanical)) fail('INVALID_MECHANICAL_BOARD_BOUNDS');
    if (native && !['none', 'rectangle'].includes(native.status)) fail('BOARD_OUTLINE_UNSUPPORTED');
    if (native?.status === 'rectangle' && !valid(native.bounds)) fail('INVALID_NATIVE_BOARD_BOUNDS');
    const sources = [[native?.status === 'rectangle' ? native.bounds : null, 'native'], [configured, 'config'], [mechanical, 'mechanical']].filter(([b]) => b != null);
    if (sources.some(([b]) => !same(b, sources[0][0]))) fail('BOARD_BOUNDS_MISMATCH');
    return { bounds: sources.length ? { ...sources[0][0] } : null, sources: sources.map(([, name]) => name) };
  }
  const boardContains = (board, b) => !board || !!b && ['minX', 'minY'].every(k => Number.isFinite(b[k]) && b[k] >= board[k] - eps)
    && ['maxX', 'maxY'].every(k => Number.isFinite(b[k]) && b[k] <= board[k] + eps);
  function checkBoardBounds(board, objects) {
    return !board ? [] : objects.filter(o => !boardContains(board, o.bbox)).map(o => ({ code: 'BOARD_BOUNDARY_VIOLATION', kind: o.kind, ref: o.ref ?? o.owner ?? o.number, id: o.id, bbox: o.bbox, boardBounds: board }));
  }
  return { resolveBoardBounds, boardContains, checkBoardBounds };
}
export const { resolveBoardBounds, boardContains, checkBoardBounds } = boardRuntime();
