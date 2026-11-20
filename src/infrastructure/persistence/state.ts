import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirectory, Fault, isRecord } from '../../shared/common.js';
import { storageLimits, storageLimit, type StorageLimits } from './storage-limits.js';

export interface Store {
  id: string;
  name: string;
  url: string;
}
export class State {
  db: DatabaseSync;
  private readonly writeContext = new AsyncLocalStorage<{ id: string; fingerprint: string }>();

  withWriteFingerprint<T>(id: string, fingerprint: string, work: () => Promise<T>) {
    return this.writeContext.run({ id, fingerprint }, work);
  }

  constructor(
    public directory = dataDirectory(),
    private configuredStore?: Store,
    public readonly limits: StorageLimits = storageLimits(),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      directory === dataDirectory() &&
      !process.env.INSALES_MCP_DATA_DIR &&
      lstatSync(directory).isSymbolicLink()
    ) {
      throw new Fault(
        'permission_denied',
        'Стандартный каталог данных не может быть символической ссылкой.',
      );
    }
    chmodSync(directory, 0o700);
    const path = join(directory, 'state.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=${limits.walBytes};
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, data TEXT NOT NULL, updated_at_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT, until_ms INTEGER);
      CREATE TABLE IF NOT EXISTS rates (id TEXT PRIMARY KEY, next_ms INTEGER);
    `);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    // SQLite itself fences database growth, including writes from maintenance.
    // An older oversized database stays readable; cleanup can shrink it safely.
    this.db.exec(
      `PRAGMA max_page_count=${Math.max(8, Math.floor(limits.databaseBytes / pageSize))}`,
    );
  }
  put(kind: string, id: string, data: unknown) {
    try {
      const context = this.writeContext.getStore();
      const record =
        kind === 'operation' && context?.id === id && isRecord(data)
          ? { ...data, request_fingerprint: context.fingerprint }
          : data;
      this.persistRecord(kind, id, record);
    } catch (error) {
      if (
        kind === 'operation' &&
        error instanceof Fault &&
        error.code === 'storage_limit_exceeded' &&
        this.db.prepare('SELECT 1 FROM records WHERE kind=? AND id=?').get(kind, id)
      ) {
        // The sending marker survives even when a completed response cannot fit.
        // Report an unknown outcome; this must never invite another POST.
        error.details.outcome = 'unknown';
        error.details.operation_id = id;
      }
      throw error;
    }
  }
  private persistRecord(kind: string, id: string, data: unknown) {
    const serialized = JSON.stringify(data);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.limits.recordBytes)
      throw storageLimit('record_bytes', this.limits.recordBytes, bytes);
    this.beforeWrite();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.checkWal();
      const previous = this.db.prepare('SELECT 1 FROM records WHERE kind=? AND id=?').get(kind, id);
      if (!previous) {
        const count = Number(this.db.prepare('SELECT count(*) AS count FROM records').get()!.count);
        if (count >= this.limits.records) throw storageLimit('records', this.limits.records, count);
        const pages = Number(this.db.prepare('PRAGMA page_count').get()!.page_count);
        const size = Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
        if (pages * size > this.limits.databaseBytes)
          throw storageLimit('database_bytes', this.limits.databaseBytes, pages * size);
      }
      this.db
        .prepare(
          'INSERT INTO records (kind,id,data,updated_at_ms) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at_ms=excluded.updated_at_ms',
        )
        .run(kind, id, serialized, Date.now());
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof Error && 'errcode' in error && error.errcode === 13)
        throw storageLimit('database_bytes', this.limits.databaseBytes, this.limits.databaseBytes);
      throw error;
    }
  }
  private walSize() {
    try {
      return statSync(join(this.directory, 'state.sqlite-wal')).size;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
      throw error;
    }
  }
  private checkWal() {
    const bytes = this.walSize();
    if (bytes >= this.limits.walBytes) throw storageLimit('wal_bytes', this.limits.walBytes, bytes);
  }
  beforeWrite() {
    if (this.walSize() < this.limits.walBytes) return;
    // journal_size_limit alone cannot stop WAL growth behind a pinned reader.
    // Try without waiting, then refuse writes until that reader releases it.
    this.db.exec('PRAGMA busy_timeout=0');
    try {
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } finally {
      this.db.exec('PRAGMA busy_timeout=5000');
    }
    this.checkWal();
  }
  storageUsage() {
    return {
      database_bytes: statSync(join(this.directory, 'state.sqlite')).size,
      wal_bytes: this.walSize(),
      records: Number(this.db.prepare('SELECT count(*) AS count FROM records').get()!.count),
      database_limit_bytes: this.limits.databaseBytes,
      wal_limit_bytes: this.limits.walBytes,
      record_limit_bytes: this.limits.recordBytes,
      records_limit: this.limits.records,
    };
  }
  get(kind: string, id: string): unknown;
  get<T>(kind: string, id: string, decode: (value: unknown) => T): T | undefined;
  get<T>(kind: string, id: string, decode?: (value: unknown) => T): unknown {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    if (!row) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(String(row.data));
    } catch {
      throw new Fault('invalid_response', 'Некорректная сохранённая запись.');
    }
    return decode ? decode(value) : value;
  }
  list(kind: string): unknown[] {
    return this.db
      .prepare('SELECT data FROM records WHERE kind=? ORDER BY id')
      .all(kind)
      .map((row) => {
        try {
          return JSON.parse(String(row.data)) as unknown;
        } catch {
          throw new Fault('invalid_response', 'Некорректная сохранённая запись.');
        }
      });
  }
  remove(kind: string, id: string) {
    this.beforeWrite();
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }
  store(id: string) {
    if (!this.configuredStore || this.configuredStore.id !== id)
      throw new Fault('permission_denied', 'Магазин недоступен этому MCP-процессу.');
    return this.configuredStore;
  }
  stores() {
    return this.configuredStore ? [this.configuredStore] : [];
  }
  rateSlot(id: string) {
    this.beforeWrite();
    const now = Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO rates VALUES (?,?) ON CONFLICT(id) DO UPDATE SET next_ms=max(rates.next_ms,?)+650 RETURNING next_ms`,
      )
      .get(id, now + 650, now);
    return Number(row!.next_ms) - 650 - now;
  }
  defer(id: string, ms: number) {
    this.beforeWrite();
    this.db
      .prepare(
        'INSERT INTO rates VALUES (?,?) ON CONFLICT(id) DO UPDATE SET next_ms=max(next_ms,excluded.next_ms)',
      )
      .run(id, Date.now() + ms);
  }
  async lock<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.beforeWrite();
    const owner = randomUUID();
    const result = this.db
      .prepare(
        `INSERT INTO leases VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms WHERE leases.until_ms<?`,
      )
      .run(id, owner, Date.now() + 120000, Date.now());
    if (!result.changes)
      throw new Fault(
        'operation_busy',
        'С магазином уже выполняется операция; повторите после её завершения.',
      );
    let renewalErrorReported = false;
    const timer = setInterval(() => {
      try {
        this.beforeWrite();
        this.db
          .prepare('UPDATE leases SET until_ms=? WHERE id=? AND owner=?')
          .run(Date.now() + 120000, id, owner);
      } catch {
        if (!renewalErrorReported)
          process.stderr.write('MCP не смог продлить блокировку локального хранилища.\n');
        renewalErrorReported = true;
      }
    }, 10000);
    timer.unref();
    try {
      return await work();
    } finally {
      clearInterval(timer);
      try {
        this.beforeWrite();
        this.db.prepare('DELETE FROM leases WHERE id=? AND owner=?').run(id, owner);
      } catch {
        // Do not mask the operation's result (especially outcome: unknown).
        // The lease expires without requiring another database write.
        process.stderr.write('MCP не смог освободить блокировку; она истечёт автоматически.\n');
      }
    }
  }
  close() {
    this.db.close();
  }
}
