import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// 同一记录的读写串行；文件替换前刷盘，失败时保留原记录。
export class RequestStore {
  constructor(stateDir) {
    this.root = join(stateDir, 'requests');
    this.operations = new Map();
  }

  path(sessionId, requestId) {
    if (!isUuid(sessionId) || !isUuid(requestId)) throw new Error('Invalid request or session UUID');
    return join(this.root, sessionId.toLowerCase(), `${requestId.toLowerCase()}.json`);
  }

  serial(sessionId, requestId, operation) {
    const path = this.path(sessionId, requestId);
    const previous = this.operations.get(path) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(path));
    this.operations.set(path, current);
    const remove = () => {
      if (this.operations.get(path) === current) this.operations.delete(path);
    };
    current.then(remove, remove);
    return current;
  }

  async read(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(path, record) {
    await mkdir(join(this.root, record.sessionId), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, path);
    } finally {
      await file?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  get(sessionId, requestId) {
    return this.serial(sessionId, requestId, (path) => this.read(path));
  }

  create(record) {
    return this.serial(record.sessionId, record.requestId, async (path) => {
      const existing = await this.read(path);
      if (existing) return { created: false, record: existing };
      await this.write(path, record);
      return { created: true, record };
    });
  }

  save(record) {
    return this.serial(record.sessionId, record.requestId, async (path) => {
      await this.write(path, record);
      return record;
    });
  }

  // 重启只修正未完成状态，不重新发送任何请求；GET 查询始终只读。
  async recover(currentSessionId) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const session of await readdir(this.root, { withFileTypes: true })) {
      if (!session.isDirectory() || !isUuid(session.name) || session.name === currentSessionId) continue;
      for (const file of await readdir(join(this.root, session.name))) {
        const requestId = file.endsWith('.json') ? file.slice(0, -5) : '';
        if (!isUuid(requestId)) continue;
        const record = await this.get(session.name, requestId);
        if (record?.status === 'running') {
          await this.save({ ...record, status: 'unknown', updatedAt: new Date().toISOString(), error: 'Bridge restarted before an execution result was recorded.' });
        }
      }
    }
  }
}
