import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoCleanupEnabled, cleanup } from '../src/infrastructure/persistence/cleanup.js';
import {
  DEFAULT_UPLOAD_DIRECTORY,
  ROOT,
  dataDirectory,
  uploadDirectory,
} from '../src/shared/common.js';
import { State } from '../src/infrastructure/persistence/state.js';

const DAY = 86_400_000;

test('default directories use the repository regardless of process cwd', () => {
  const originalCwd = process.cwd();
  const originalData = process.env.INSALES_MCP_DATA_DIR;
  const originalUpload = process.env.INSALES_MCP_UPLOAD_DIR;
  const directory = mkdtempSync(join(tmpdir(), 'insales-paths-'));
  try {
    delete process.env.INSALES_MCP_DATA_DIR;
    delete process.env.INSALES_MCP_UPLOAD_DIR;
    process.chdir(directory);
    assert.equal(dataDirectory(), join(ROOT, '.data'));
    assert.equal(uploadDirectory(), DEFAULT_UPLOAD_DIRECTORY);
  } finally {
    process.chdir(originalCwd);
    if (originalData === undefined) delete process.env.INSALES_MCP_DATA_DIR;
    else process.env.INSALES_MCP_DATA_DIR = originalData;
    if (originalUpload === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = originalUpload;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanup previews and removes expired records and unreferenced old uploads', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-cleanup-'));
  const uploads = join(directory, 'uploads');
  mkdirSync(uploads);
  const state = new State(join(directory, 'data'));
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = Date.now();
  const old = new Date(now - 8 * DAY);
  const file = (name: string) => {
    const path = join(uploads, name);
    writeFileSync(path, name);
    utimesSync(path, old, old);
    return path;
  };
  const abandoned = file('abandoned.png');
  const stale = file('stale.png');
  const retained = file('retained.png');
  const active = file('active.png');
  const outside = join(directory, 'outside.png');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(uploads, 'link.png'));
  const recent = join(uploads, 'recent.png');
  writeFileSync(recent, 'recent');
  state.put('draft', 'abandoned', { expires_at: now - 1 });
  state.put('draft', 'stale', { expires_at: now - DAY, local_file: { path: stale } });
  state.put('operation', 'stale', { id: 'stale', store_id: 'one', status: 'applied' });
  state.db
    .prepare("UPDATE records SET updated_at_ms=? WHERE kind='operation' AND id='stale'")
    .run(now - 8 * DAY);
  state.put('draft', 'retained', { expires_at: now - DAY, local_file: { path: retained } });
  state.put('operation', 'retained', {
    id: 'retained',
    store_id: 'one',
    status: 'execution_unknown',
  });
  state.put('draft', 'active', { expires_at: now + DAY, local_files: { front: { path: active } } });
  state.put('draft', 'batch', { expires_at: now - DAY, items: [{ local_file: { path: active } }] });
  state.put('operation', 'batch', {
    id: 'batch',
    store_id: 'one',
    status: 'running',
    items: [{ change_id: 'child', status: 'sending' }],
  });
  state.put('draft', 'child', { expires_at: now - DAY, local_file: { path: active } });
  state.put('operation', 'child', { id: 'child', store_id: 'one', status: 'execution_unknown' });
  state.db
    .prepare("UPDATE records SET updated_at_ms=? WHERE kind='operation' AND id='child'")
    .run(now - 8 * DAY);
  const preview = await cleanup(state, { now, uploadRoot: uploads });
  assert.equal(preview.applied, false);
  assert.equal(preview.drafts, 2);
  assert.equal(preview.operations, 1);
  assert.equal(preview.upload_files, 2);
  assert.ok(preview.candidates.upload_paths.includes('abandoned.png'));
  assert.ok(preview.candidates.upload_paths.includes('stale.png'));
  assert.ok(existsSync(abandoned));
  assert.ok(state.get('draft', 'abandoned'));

  const applied = await cleanup(state, { apply: true, now, uploadRoot: uploads });
  assert.equal(applied.deleted_upload_files, 2);
  assert.equal(state.get('draft', 'abandoned'), undefined);
  assert.equal(state.get('draft', 'stale'), undefined);
  assert.equal(state.get('operation', 'stale'), undefined);
  assert.ok(state.get('draft', 'retained'));
  assert.ok(state.get('operation', 'retained'));
  assert.ok(state.get('draft', 'child'));
  assert.ok(state.get('operation', 'child'));
  assert.ok(existsSync(retained));
  assert.ok(existsSync(active));
  assert.ok(existsSync(recent));
  assert.ok(existsSync(outside));
  assert.ok(existsSync(join(uploads, 'link.png')));
  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(stale), false);
});

test('configured upload directory is never cleaned and auto cleanup flag accepts 1 or 0', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-custom-upload-'));
  const state = new State(join(directory, 'data'));
  const originalUpload = process.env.INSALES_MCP_UPLOAD_DIR;
  const originalAuto = process.env.INSALES_MCP_AUTO_CLEANUP;
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
    if (originalUpload === undefined) delete process.env.INSALES_MCP_UPLOAD_DIR;
    else process.env.INSALES_MCP_UPLOAD_DIR = originalUpload;
    if (originalAuto === undefined) delete process.env.INSALES_MCP_AUTO_CLEANUP;
    else process.env.INSALES_MCP_AUTO_CLEANUP = originalAuto;
  });
  const uploads = join(directory, 'custom');
  mkdirSync(uploads);
  const path = join(uploads, 'old.png');
  writeFileSync(path, 'old');
  const old = new Date(Date.now() - 8 * DAY);
  utimesSync(path, old, old);
  process.env.INSALES_MCP_UPLOAD_DIR = uploads;
  const result = await cleanup(state, { apply: true, uploadRoot: uploads });
  assert.equal(result.upload_files, 0);
  assert.ok(result.skipped_uploads);
  assert.ok(existsSync(path));
  delete process.env.INSALES_MCP_AUTO_CLEANUP;
  assert.equal(autoCleanupEnabled(), true);
  process.env.INSALES_MCP_AUTO_CLEANUP = '0';
  assert.equal(autoCleanupEnabled(), false);
  process.env.INSALES_MCP_AUTO_CLEANUP = 'unexpected';
  assert.throws(autoCleanupEnabled, (error: any) => error.code === 'invalid_config');
});

test('default downloads expire like uploads and a configured directory is kept', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-downloads-'));
  const downloads = join(directory, 'downloads');
  mkdirSync(downloads);
  const state = new State(join(directory, 'data'));
  const original = process.env.INSALES_MCP_DOWNLOAD_DIR;
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
    if (original === undefined) delete process.env.INSALES_MCP_DOWNLOAD_DIR;
    else process.env.INSALES_MCP_DOWNLOAD_DIR = original;
  });
  const now = Date.now();
  const old = new Date(now - 8 * DAY);
  const expired = join(downloads, 'old.png');
  const recent = join(downloads, 'recent.png');
  writeFileSync(expired, 'old');
  writeFileSync(recent, 'recent');
  utimesSync(expired, old, old);
  delete process.env.INSALES_MCP_DOWNLOAD_DIR;
  const preview = await cleanup(state, { now, downloadRoot: downloads });
  assert.equal(preview.download_files, 1);
  assert.equal(existsSync(expired), true);
  const applied = await cleanup(state, { apply: true, now, downloadRoot: downloads });
  assert.equal(applied.deleted_download_files, 1);
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(recent), true);

  writeFileSync(expired, 'old');
  utimesSync(expired, old, old);
  process.env.INSALES_MCP_DOWNLOAD_DIR = downloads;
  const kept = await cleanup(state, { apply: true, now, downloadRoot: downloads });
  assert.equal(kept.download_files, 0);
  assert.match(kept.skipped_downloads ?? '', /INSALES_MCP_DOWNLOAD_DIR/);
  assert.equal(existsSync(expired), true);
});

test('cleanup CLI previews without deleting and applies with --apply', () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-cleanup-cli-'));
  const data = join(directory, 'data');
  const state = new State(data);
  state.put('draft', 'old', { expires_at: Date.now() - 1 });
  state.close();
  const env = { ...process.env, INSALES_MCP_DATA_DIR: data, INSALES_MCP_UPLOAD_DIR: directory };
  try {
    const command = join(ROOT, 'bin/cleanup.mjs');
    const preview = JSON.parse(
      execFileSync(process.execPath, [command], { env, encoding: 'utf8' }),
    );
    assert.equal(preview.applied, false);
    assert.equal(preview.drafts, 1);
    const before = new State(data);
    assert.ok(before.get('draft', 'old'));
    before.close();
    const applied = JSON.parse(
      execFileSync(process.execPath, [command, '--apply'], { env, encoding: 'utf8' }),
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.compacted, true);
    const after = new State(data);
    assert.equal(after.get('draft', 'old'), undefined);
    after.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
