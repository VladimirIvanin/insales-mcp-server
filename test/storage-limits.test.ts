import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { State } from '../src/infrastructure/persistence/state.js';
import {
  storageLimits,
  type StorageLimits,
} from '../src/infrastructure/persistence/storage-limits.js';
import { assertUploadBudget } from '../src/infrastructure/uploads/budget.js';
import { cleanup } from '../src/infrastructure/persistence/cleanup.js';
import { Fault, ROOT } from '../src/shared/common.js';
import { Api, type Transport } from '../src/api.js';
import { readFileSync } from 'node:fs';

const MIB = 1024 * 1024;
const DAY = 86_400_000;
const isLimit = (resource: string) => (error: unknown) =>
  error instanceof Fault &&
  error.code === 'storage_limit_exceeded' &&
  error.details.resource === resource;

function fixture(t: TestContext, overrides: Partial<StorageLimits> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'insales-storage-budget-'));
  const state = new State(directory, undefined, { ...storageLimits(), ...overrides });
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, state };
}

test('storage configuration rejects disabled, fractional and overflowing limits', () => {
  const original = process.env.INSALES_MCP_MAX_DATABASE_MB;
  try {
    for (const value of ['0', '-1', '1.5', 'wrong', '9007199254740991']) {
      process.env.INSALES_MCP_MAX_DATABASE_MB = value;
      assert.throws(
        storageLimits,
        (error: unknown) => error instanceof Fault && error.code === 'invalid_config',
      );
    }
    process.env.INSALES_MCP_MAX_DATABASE_MB = '64';
    assert.equal(storageLimits().databaseBytes, 64 * MIB);
  } finally {
    if (original === undefined) delete process.env.INSALES_MCP_MAX_DATABASE_MB;
    else process.env.INSALES_MCP_MAX_DATABASE_MB = original;
  }
});

test('record count and record size stop growth but permit updating an existing unknown operation', (t) => {
  const { state } = fixture(t, { records: 2, recordBytes: 4096 });
  state.put('draft', 'one', { expires_at: Date.now() + DAY });
  state.put('operation', 'one', {
    id: 'one',
    store_id: 'shop',
    status: 'execution_unknown',
    items: [],
  });
  assert.throws(
    () => state.put('draft', 'two', { expires_at: Date.now() + DAY }),
    isLimit('records'),
  );
  assert.throws(
    () => state.put('draft', 'oversized', { data: 'x'.repeat(4096) }),
    isLimit('record_bytes'),
  );
  state.put('operation', 'one', { id: 'one', store_id: 'shop', status: 'applied', items: [] });
  assert.equal((state.get('operation', 'one') as { status: string }).status, 'applied');
  assert.equal(state.get('draft', 'two'), undefined);
});

test('SQLite page cap rejects a large insertion atomically and preserves earlier data', (t) => {
  const { state } = fixture(t, { databaseBytes: MIB, recordBytes: 3 * MIB });
  state.put('operation', 'unknown', {
    id: 'unknown',
    store_id: 'shop',
    status: 'execution_unknown',
  });
  assert.throws(
    () => state.put('draft', 'too-big', { data: 'x'.repeat(2 * MIB) }),
    isLimit('database_bytes'),
  );
  assert.equal(state.get('draft', 'too-big'), undefined);
  assert.ok(state.get('operation', 'unknown'));
  assert.equal(state.db.isTransaction, false);
  const pages = Number(state.db.prepare('PRAGMA page_count').get()!.page_count);
  const pageSize = Number(state.db.prepare('PRAGMA page_size').get()!.page_size);
  assert.ok(pages * pageSize <= MIB);
  state.put('draft', 'small', { expires_at: Date.now() + DAY });
});

test('a pinned reader cannot grow WAL indefinitely and writes resume after its release', (t) => {
  const { state, directory } = fixture(t, { walBytes: 64 * 1024 });
  state.put('draft', 'one', { data: 'x'.repeat(8192) });
  state.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const reader = new State(directory, undefined, state.limits);
  reader.db.exec('BEGIN');
  reader.get('draft', 'one');
  let blocked = false;
  try {
    for (let index = 0; index < 50; index++) {
      try {
        state.put('draft', 'one', { data: String(index).repeat(4096) });
      } catch (error) {
        assert.ok(isLimit('wal_bytes')(error));
        blocked = true;
        break;
      }
    }
    assert.ok(blocked);
    const bytes = statSync(join(directory, 'state.sqlite-wal')).size;
    for (let index = 0; index < 10; index++)
      assert.throws(() => state.put('draft', 'one', {}), isLimit('wal_bytes'));
    assert.equal(statSync(join(directory, 'state.sqlite-wal')).size, bytes);
    assert.ok(bytes < state.limits.walBytes + 32 * 1024);
  } finally {
    reader.db.exec('ROLLBACK');
    reader.close();
  }
  state.put('draft', 'one', { recovered: true });
  assert.deepEqual(state.get('draft', 'one'), { recovered: true });
});

test('record limit is shared by separate SQLite connections', (t) => {
  const { state, directory } = fixture(t, { records: 2 });
  const other = new State(directory, undefined, state.limits);
  try {
    state.put('draft', 'one', {});
    other.put('operation', 'one', { status: 'execution_unknown' });
    assert.throws(() => state.put('draft', 'two', {}), isLimit('records'));
    assert.throws(() => other.put('draft', 'three', {}), isLimit('records'));
    assert.equal(other.storageUsage().records, 2);
  } finally {
    other.close();
  }
});

test('automatic compaction shrinks the database and checkpoints WAL after VACUUM', async (t) => {
  const { state, directory } = fixture(t);
  state.put('draft', 'expired', { expires_at: Date.now() - 1, data: 'x'.repeat(2 * MIB) });
  state.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const before = statSync(join(directory, 'state.sqlite')).size;
  const report = await cleanup(state, {
    apply: true,
    compact: 'auto',
    uploadRoot: join(directory, 'absent'),
  });
  assert.equal(report.compacted, true);
  assert.ok(statSync(join(directory, 'state.sqlite')).size < before / 2);
  assert.ok(statSync(join(directory, 'state.sqlite-wal')).size < 64 * 1024);
  assert.equal(state.get('draft', 'expired'), undefined);
});

test('cleanup keeps old unknown operations, all image fields and nonempty folders', async (t) => {
  const { state, directory } = fixture(t);
  const uploads = join(directory, 'uploads');
  const empty = join(uploads, 'abandoned');
  mkdirSync(empty, { recursive: true });
  const old = new Date(Date.now() - 30 * DAY);
  for (const key of ['file', 'preview_file', 'local_file']) {
    const path = join(uploads, `${key}.png`);
    writeFileSync(path, key);
    utimesSync(path, old, old);
    state.put('draft', key, { expires_at: Date.now() - DAY, [key]: { path } });
    state.put('operation', key, {
      store_id: 'shop',
      ...(key === 'local_file' ? {} : { status: 'execution_unknown' }),
      items: [],
    });
  }
  state.db.prepare("UPDATE records SET updated_at_ms=? WHERE kind='operation'").run(old.getTime());
  const abandoned = join(empty, 'old.png');
  writeFileSync(abandoned, 'old');
  utimesSync(abandoned, old, old);
  await cleanup(state, { apply: true, uploadRoot: uploads });
  for (const key of ['file', 'preview_file', 'local_file']) {
    assert.ok(existsSync(join(uploads, `${key}.png`)));
    assert.ok(state.get('operation', key));
    assert.ok(state.get('draft', key));
  }
  assert.equal(existsSync(empty), false);
});

test('an isolated database never cleans images from the shared upload directory it cannot protect', async (t) => {
  const { state } = fixture(t);
  const report = await cleanup(state, { apply: true });
  assert.equal(report.upload_files, 0);
  assert.equal(report.deleted_upload_files, 0);
  assert.match(report.skipped_uploads ?? '', /Отдельная SQLite/);
});

test('upload budget rejects excessive bytes, file count and directory-only growth without deleting inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-upload-budget-'));
  const original = process.env.INSALES_MCP_MAX_UPLOAD_FILES;
  const originalBytes = process.env.INSALES_MCP_MAX_UPLOAD_MB;
  try {
    process.env.INSALES_MCP_MAX_UPLOAD_FILES = '2';
    process.env.INSALES_MCP_MAX_UPLOAD_MB = '1';
    for (let i = 0; i < 3; i++) writeFileSync(join(directory, String(i)), 'image');
    await assert.rejects(assertUploadBudget(directory), isLimit('upload_files'));
    assert.ok(existsSync(join(directory, '0')));
    rmSync(join(directory, '2'));
    writeFileSync(join(directory, '0'), Buffer.alloc(MIB + 1));
    await assert.rejects(assertUploadBudget(directory), isLimit('upload_bytes'));
    rmSync(join(directory, '0'));
    rmSync(join(directory, '1'));
    for (let i = 0; i < 9; i++) mkdirSync(join(directory, String(i)));
    await assert.rejects(assertUploadBudget(directory), isLimit('upload_entries'));
  } finally {
    if (original === undefined) delete process.env.INSALES_MCP_MAX_UPLOAD_FILES;
    else process.env.INSALES_MCP_MAX_UPLOAD_FILES = original;
    if (originalBytes === undefined) delete process.env.INSALES_MCP_MAX_UPLOAD_MB;
    else process.env.INSALES_MCP_MAX_UPLOAD_MB = originalBytes;
    rmSync(directory, { recursive: true, force: true });
  }
});
