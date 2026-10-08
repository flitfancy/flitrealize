/** EasyEDA native process, snapshots and transaction receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { statePathEnvironment } from '../../lib/state-paths.mjs';
import { canonical, invariant } from './source-invariant.mjs';
const exec = promisify(execFile), scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
export async function prepareNativeSource(directory) {
  const geometry = (await fs.readFile(path.join(scripts, 'pcb-routing/geometry.mjs'), 'utf8')).replace(/\bexport\s+/g, '');
  const source = (await fs.readFile(new URL('./source-invariant.mjs', import.meta.url), 'utf8')).replace(/\bexport\s+/g, '');
  const controller = await fs.readFile(path.join(scripts, 'providers/easyeda-pro/routing-native.js'), 'utf8');
  const file = path.join(directory, 'routing-native.js');
  await fs.writeFile(file, geometry + '\n' + source + '\n' + controller);
  return file;
}
export async function executeNative({ directory, windowId, mode, input = {}, logName = mode, sourceFile = null }) {
  const codeFile = sourceFile ?? await prepareNativeSource(directory), inputFile = path.join(directory, logName + '-input.json'), reportFile = path.join(directory, logName + '-result.json');
  await fs.writeFile(inputFile, JSON.stringify({ ...input, mode }));
  const args = [path.join(scripts, 'eda-host.mjs'), 'execute', '--eda', 'easyeda-pro', '--window-id', windowId, '--code-file', codeFile, '--input-file', inputFile];
  let text;
  try { text = (await exec(process.execPath, args, { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024, env: statePathEnvironment() })).stdout; }
  catch (error) {
    text = error.stdout ?? '';
    await fs.writeFile(reportFile, text + (error.stderr ?? ''));
    throw Object.assign(Error('NATIVE_REQUEST_UNRESOLVED'), { receiptFile: reportFile, cause: error });
  }
  await fs.writeFile(reportFile, text);
  const r = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!r.success) throw Object.assign(Error('NATIVE_EXECUTION_FAILED'), { receiptFile: reportFile });
  return r.result;
}
export async function activeWindow() {
  const r = await exec(process.execPath, [path.join(scripts, 'eda-host.mjs'), 'status', '--eda', 'easyeda-pro'], { windowsHide: true, timeout: 10000, env: statePathEnvironment() });
  const status = JSON.parse(r.stdout);
  if (status.eda?.windows?.length !== 1) throw Error('EXACTLY_ONE_EDA_WINDOW_REQUIRED');
  return status.eda.windows[0].windowId;
}
export function legacySnapshot(exportRead, padRead) {
  const b = structuredClone(exportRead.result ?? exportRead), p = padRead.result ?? padRead;
  b.sourceInvariantHash = digest(invariant(b.source));
  b.footprintHash = digest((p.footprintSources ?? []).slice().sort((a, b) => a.footprintUuid.localeCompare(b.footprintUuid)));
  return { ...b, pads: p.pads, components: p.components, footprintSources: p.footprintSources ?? [], dsnText: b.dsn?.text };
}
export function updateBoardSnapshot(board, snapshot) {
  return { ...board, native: snapshot,
    segments: snapshot.objects.lines.map(s => ({ id: s.PrimitiveId, net: s.Net, layer: s.Layer, width: s.LineWidth, x1: s.StartX, y1: s.StartY, x2: s.EndX, y2: s.EndY, locked: s.PrimitiveLock })),
    vias: snapshot.objects.vias.map(v => ({ id: v.PrimitiveId, net: v.Net, x: v.X, y: v.Y, hole: v.HoleDiameter, diameter: v.Diameter, layers: board.layers, locked: v.PrimitiveLock })) };
}
