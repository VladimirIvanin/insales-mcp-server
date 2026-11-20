import { lstat, opendir, realpath, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_DOWNLOAD_DIRECTORY,
  DEFAULT_UPLOAD_DIRECTORY,
  ROOT,
  Fault,
} from '../../shared/common.js';
import type { State } from './state.js';

const DAY = 86_400_000;
const OPERATION_RETENTION = 7 * DAY;
const UPLOAD_RETENTION = 7 * DAY;

interface Row {
  id: string;
  data: string;
  updated_at_ms: number;
}
interface CandidateFile {
  path: string;
  relative_path: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}
interface Snapshot {
  codeRecords: Array<{ kind: string; id: string }>;
  codeCompactions: Array<{ id: string; data: Record<string, unknown> }>;
  drafts: string[];
  operations: string[];
  staleLeases: string[];
  staleRates: string[];
  protectedFiles: Set<string>;
  recordBytes: number;
  unknownOperations: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown) {
  return record(error) && typeof error.code === 'string' ? error.code : undefined;
}

function referencedFiles(draft: unknown, result: Set<string>) {
  if (!record(draft)) return;
  for (const file of [draft.local_file, draft.file, draft.preview_file])
    if (record(file) && typeof file.path === 'string') result.add(file.path);
  if (record(draft.local_files)) {
    for (const file of Object.values(draft.local_files))
      if (record(file) && typeof file.path === 'string') result.add(file.path);
  }
  if (Array.isArray(draft.items)) for (const item of draft.items) referencedFiles(item, result);
}

function snapshot(state: State, now: number): Snapshot {
  const operations = new Map<
    string,
    {
      data: { store_id: string; items: unknown[] };
      unresolved: boolean;
      updatedAt: number;
      bytes: number;
    }
  >();
  const activeLeases = new Set(
    state.db
      .prepare('SELECT id FROM leases WHERE until_ms>?')
      .all(now)
      .map((row) => String(row.id)),
  );
  const result: Snapshot = {
    codeRecords: [],
    codeCompactions: [],
    drafts: [],
    operations: [],
    staleLeases: [],
    staleRates: [],
    protectedFiles: new Set(),
    recordBytes: 0,
    unknownOperations: 0,
  };
  for (const row of state.db
    .prepare("SELECT id,data,updated_at_ms FROM records WHERE kind='operation'")
    .iterate() as Iterable<Row>) {
    const data: unknown = JSON.parse(row.data);
    if (
      !record(data) ||
      typeof data.store_id !== 'string' ||
      (data.items !== undefined && !Array.isArray(data.items))
    )
      throw new Fault('invalid_response', 'Некорректная сохранённая операция.');
    operations.set(row.id, {
      data: { store_id: data.store_id, items: data.items ?? [] },
      unresolved:
        // Unknown legacy statuses are retained too; absence is never proof of completion.
        !['applied', 'partial_failure', 'failed'].includes(String(data.status)) ||
        (data.items ?? []).some(
          (item) =>
            record(item) &&
            ['running', 'sending', 'execution_unknown'].includes(String(item.status)),
        ),
      updatedAt: Number(row.updated_at_ms),
      bytes: Buffer.byteLength(row.data),
    });
  }
  const retained = new Set<string>();
  const queue: string[] = [];
  for (const [id, operation] of operations) {
    if (operation.unresolved) result.unknownOperations++;
    if (
      operation.unresolved ||
      operation.updatedAt > now - OPERATION_RETENTION ||
      activeLeases.has(String(operation.data.store_id)) ||
      activeLeases.has(`batch:${id}`)
    ) {
      retained.add(id);
      queue.push(id);
    }
  }
  // A retained image batch may still need a child operation to avoid resending a POST.
  for (const id of queue) {
    for (const item of operations.get(id)?.data.items ?? []) {
      const child = record(item) ? item.change_id : undefined;
      if (typeof child === 'string' && operations.has(child) && !retained.has(child)) {
        retained.add(child);
        queue.push(child);
      }
    }
  }
  for (const [id, operation] of operations) {
    if (!retained.has(id)) {
      result.operations.push(id);
      result.recordBytes += operation.bytes;
    }
  }
  for (const row of state.db
    .prepare("SELECT id,data,updated_at_ms FROM records WHERE kind='draft'")
    .iterate() as Iterable<Row>) {
    const draft: unknown = JSON.parse(row.data);
    const expired =
      record(draft) && typeof draft.expires_at === 'number' && draft.expires_at <= now;
    const keep = !expired || retained.has(row.id);
    if (keep) referencedFiles(draft, result.protectedFiles);
    else {
      result.drafts.push(row.id);
      result.recordBytes += Buffer.byteLength(row.data);
    }
  }
  const codeRows = state.db
    .prepare(
      "SELECT kind,id,data,updated_at_ms FROM records WHERE kind IN ('code_execution','code_result','code_read_result') ORDER BY CASE kind WHEN 'code_execution' THEN 0 ELSE 1 END",
    )
    .all();
  const protectedResults = new Set<string>();
  for (const row of codeRows) {
    const kind = String(row.kind);
    const data: unknown = JSON.parse(String(row.data));
    const linkedUnknown =
      record(data) &&
      Array.isArray(data.steps) &&
      data.steps.some(
        (step) =>
          record(step) &&
          (['sending', 'execution_unknown'].includes(String(step.status)) ||
            (typeof step.operation_id === 'string' &&
              operations.get(step.operation_id)?.unresolved) ||
            (typeof step.change_id === 'string' && operations.get(step.change_id)?.unresolved)),
      );
    const age = kind === 'code_read_result' ? DAY : OPERATION_RETENTION;
    const fresh = Number(row.updated_at_ms) > now - age;
    if (kind === 'code_execution') {
      if (
        !record(data) ||
        data.status === 'running' ||
        data.status === 'expired' ||
        linkedUnknown ||
        fresh
      ) {
        if (record(data))
          for (const ref of [data.result_ref, data.error_ref])
            if (typeof ref === 'string') protectedResults.add(ref);
      } else {
        result.codeCompactions.push({
          id: String(row.id),
          data: {
            execution_id: data.execution_id,
            fingerprint: data.fingerprint,
            status: 'expired',
            steps: [],
            error: {
              code: 'execution_expired',
              message:
                'Результат запуска удалён по сроку хранения; повторное исполнение этого execution_id запрещено.',
            },
          },
        });
      }
      continue;
    }
    if (fresh || protectedResults.has(String(row.id))) continue;
    result.codeRecords.push({ kind, id: String(row.id) });
    result.recordBytes += Buffer.byteLength(String(row.data));
  }
  result.staleLeases = state.db
    .prepare('SELECT id FROM leases WHERE until_ms<=?')
    .all(now)
    .map((row) => String(row.id));
  result.staleRates = state.db
    .prepare('SELECT id FROM rates WHERE next_ms<=?')
    .all(now - OPERATION_RETENTION)
    .map((row) => String(row.id));
  return result;
}

async function uploadCandidates(
  protectedFiles: Set<string>,
  now: number,
  rootPath: string,
  scanLimit: number,
): Promise<{ files: CandidateFile[]; directories?: string[]; root?: string; skipped?: string }> {
  if (process.env.INSALES_MCP_UPLOAD_DIR)
    return { files: [], skipped: 'Каталог INSALES_MCP_UPLOAD_DIR не очищается.' };
  let rootInfo;
  try {
    rootInfo = await lstat(rootPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { files: [] };
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    return { files: [], skipped: 'Стандартный каталог загрузок не является обычной директорией.' };
  const root = await realpath(rootPath);
  const files: CandidateFile[] = [];
  const directories: string[] = [];
  let visited = 0;
  async function visit(directory: string) {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++visited > scanLimit) return;
      const path = join(directory, entry.name);
      const info = await lstat(path).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (!info || info.isSymbolicLink()) continue;
      const actual = await realpath(path);
      const inside = relative(root, actual);
      if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        continue;
      if (info.isDirectory()) {
        await visit(path);
        directories.push(path);
      } else if (
        info.isFile() &&
        info.mtimeMs <= now - UPLOAD_RETENTION &&
        !protectedFiles.has(actual)
      ) {
        files.push({
          path,
          relative_path: inside,
          size: info.size,
          mtimeMs: info.mtimeMs,
          dev: info.dev,
          ino: info.ino,
        });
      }
    }
  }
  await visit(rootPath);
  return {
    files,
    directories,
    root,
    ...(visited > scanLimit
      ? {
          skipped: `За один проход проверены первые ${scanLimit} entries; остальные будут проверены после освобождения места.`,
        }
      : {}),
  };
}

async function downloadCandidates(
  now: number,
  rootPath: string,
  scanLimit: number,
): Promise<{ files: CandidateFile[]; root?: string; skipped?: string }> {
  if (process.env.INSALES_MCP_DOWNLOAD_DIR)
    return { files: [], skipped: 'Каталог INSALES_MCP_DOWNLOAD_DIR не очищается.' };
  let rootInfo;
  try {
    rootInfo = await lstat(rootPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { files: [] };
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    return {
      files: [],
      skipped: 'Стандартный каталог скачивания не является обычной директорией.',
    };
  const root = await realpath(rootPath);
  const files: CandidateFile[] = [];
  let visited = 0;
  async function visit(directory: string) {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++visited > scanLimit) return;
      const path = join(directory, entry.name);
      const info = await lstat(path).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (!info || info.isSymbolicLink()) continue;
      const actual = await realpath(path);
      const inside = relative(root, actual);
      if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        continue;
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && info.mtimeMs <= now - UPLOAD_RETENTION) {
        files.push({
          path,
          relative_path: inside,
          size: info.size,
          mtimeMs: info.mtimeMs,
          dev: info.dev,
          ino: info.ino,
        });
      }
    }
  }
  await visit(rootPath);
  return {
    files,
    root,
    ...(visited > scanLimit
      ? {
          skipped: `За один проход проверены первые ${scanLimit} entries скачивания; остальные будут проверены после освобождения места.`,
        }
      : {}),
  };
}

export interface CleanupReport {
  applied: boolean;
  drafts: number;
  operations: number;
  code_records: number;
  code_compactions: number;
  retained_unknown_operations: number;
  stale_leases: number;
  stale_rates: number;
  upload_files: number;
  download_files: number;
  estimated_record_bytes: number;
  upload_bytes: number;
  candidates: {
    draft_ids: string[];
    operation_ids: string[];
    upload_paths: string[];
    truncated: boolean;
  };
  skipped_uploads?: string;
  skipped_downloads?: string;
  deleted_upload_files?: number;
  deleted_download_files?: number;
  compacted?: boolean;
  compaction_skipped?: string;
  storage?: {
    database_bytes: number;
    wal_bytes: number;
    records: number;
    database_limit_bytes: number;
    wal_limit_bytes: number;
    record_limit_bytes: number;
    records_limit: number;
  };
}

export async function cleanup(
  state: State,
  options: {
    apply?: boolean;
    compact?: boolean | 'auto';
    now?: number;
    uploadRoot?: string;
    downloadRoot?: string;
  } = {},
): Promise<CleanupReport> {
  if (options.compact && !options.apply)
    throw new Fault('invalid_config', 'Сжатие SQLite требует применения очистки.');
  const now = options.now ?? Date.now();
  const work = async () => {
    const candidates = snapshot(state, now);
    const rootPath = options.uploadRoot ?? DEFAULT_UPLOAD_DIRECTORY;
    // A separate SQLite file cannot see drafts protecting the shared upload directory.
    const ownsUploads =
      resolve(rootPath) !== resolve(DEFAULT_UPLOAD_DIRECTORY) ||
      resolve(state.directory) === resolve(ROOT, '.data');
    const uploads: {
      files: CandidateFile[];
      directories?: string[];
      root?: string;
      skipped?: string;
    } = !ownsUploads
      ? {
          files: [],
          skipped:
            'Отдельная SQLite не очищает общую .uploads: она не знает о черновиках основной базы.',
        }
      : await uploadCandidates(
          candidates.protectedFiles,
          now,
          rootPath,
          state.limits.uploadFiles * 4,
        ).catch(() => ({
          files: [],
          skipped: 'Не удалось проверить каталог загрузок; очистка SQLite продолжается.',
        }));
    const ownsDownloads =
      options.downloadRoot !== undefined || resolve(state.directory) === resolve(ROOT, '.data');
    const downloads: { files: CandidateFile[]; root?: string; skipped?: string } = !ownsDownloads
      ? { files: [] }
      : await downloadCandidates(
          now,
          options.downloadRoot ?? DEFAULT_DOWNLOAD_DIRECTORY,
          state.limits.uploadFiles * 4,
        ).catch(() => ({
          files: [],
          skipped: 'Не удалось проверить каталог скачивания; очистка SQLite продолжается.',
        }));
    const sample = 100;
    const report: CleanupReport = {
      applied: !!options.apply,
      drafts: candidates.drafts.length,
      operations: candidates.operations.length,
      code_records: candidates.codeRecords.length,
      code_compactions: candidates.codeCompactions.length,
      retained_unknown_operations: candidates.unknownOperations,
      stale_leases: candidates.staleLeases.length,
      stale_rates: candidates.staleRates.length,
      upload_files: uploads.files.length,
      download_files: downloads.files.length,
      estimated_record_bytes: candidates.recordBytes,
      upload_bytes: uploads.files.reduce((sum, file) => sum + file.size, 0),
      candidates: {
        draft_ids: candidates.drafts.slice(0, sample),
        operation_ids: candidates.operations.slice(0, sample),
        upload_paths: uploads.files.slice(0, sample).map((file) => file.relative_path),
        truncated:
          candidates.drafts.length > sample ||
          candidates.operations.length > sample ||
          uploads.files.length > sample,
      },
    };
    if (uploads.skipped) report.skipped_uploads = uploads.skipped;
    if (downloads.skipped) report.skipped_downloads = downloads.skipped;
    report.storage = state.storageUsage();
    if (!options.apply) return report;

    let protectedAfter: Set<string>;
    state.beforeWrite();
    state.db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after scanning files: another MCP process may have updated an operation.
      const fresh = snapshot(state, now);
      protectedAfter = fresh.protectedFiles;
      const removeRecord = state.db.prepare('DELETE FROM records WHERE kind=? AND id=?');
      for (const row of fresh.codeCompactions)
        state.db
          .prepare("UPDATE records SET data=? WHERE kind='code_execution' AND id=?")
          .run(JSON.stringify(row.data), row.id);
      for (const row of fresh.codeRecords) removeRecord.run(row.kind, row.id);
      for (const id of fresh.drafts) removeRecord.run('draft', id);
      for (const id of fresh.operations) removeRecord.run('operation', id);
      const removeLease = state.db.prepare('DELETE FROM leases WHERE id=? AND until_ms<=?');
      for (const id of fresh.staleLeases) removeLease.run(id, now);
      const removeRate = state.db.prepare('DELETE FROM rates WHERE id=? AND next_ms<=?');
      for (const id of fresh.staleRates) removeRate.run(id, now - OPERATION_RETENTION);
      state.db.exec('COMMIT');
    } catch (error) {
      if (state.db.isTransaction) state.db.exec('ROLLBACK');
      throw error;
    }

    let deleted = 0;
    for (const file of uploads.files) {
      if (protectedAfter.has(join(uploads.root!, file.relative_path))) continue;
      const rootInfo = await lstat(rootPath).catch(() => undefined);
      if (
        !rootInfo?.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        (await realpath(rootPath).catch(() => undefined)) !== uploads.root
      )
        break;
      const info = await lstat(file.path).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        info.dev !== file.dev ||
        info.ino !== file.ino ||
        info.size !== file.size ||
        info.mtimeMs !== file.mtimeMs
      )
        continue;
      const actual = await realpath(file.path).catch(() => undefined);
      if (!actual) continue;
      const inside = relative(uploads.root!, actual);
      if (inside !== file.relative_path) continue;
      await unlink(file.path);
      deleted++;
    }
    report.deleted_upload_files = deleted;
    let deletedDownloads = 0;
    for (const file of downloads.files) {
      if (!downloads.root) continue;
      const info = await lstat(file.path).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        info.dev !== file.dev ||
        info.ino !== file.ino ||
        info.size !== file.size ||
        info.mtimeMs !== file.mtimeMs
      )
        continue;
      const actual = await realpath(file.path).catch(() => undefined);
      if (!actual || relative(downloads.root, actual) !== file.relative_path) continue;
      await unlink(file.path);
      deletedDownloads++;
    }
    report.deleted_download_files = deletedDownloads;
    for (const directory of uploads.directories ?? []) {
      const info = await lstat(directory).catch(() => undefined);
      const actual = await realpath(directory).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink() || !actual || !uploads.root) continue;
      const inside = relative(uploads.root, actual);
      if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        continue;
      // Only empty directories are removed; rmdir never recursively removes files.
      await rmdir(directory).catch(() => {});
    }
    if (options.compact) {
      const active = state.db
        .prepare(
          "SELECT count(*) AS count FROM leases WHERE until_ms>? AND id NOT IN ('maintenance:cleanup','maintenance:uploads')",
        )
        .get(Date.now());
      if (Number(active?.count) > 0) report.compaction_skipped = 'Есть активные операции MCP.';
      else {
        try {
          const checkpoint = state.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
          if (Number(checkpoint?.busy) !== 0)
            report.compaction_skipped = 'SQLite reader удерживает WAL; повторите очистку позже.';
          else {
            const free = Number(state.db.prepare('PRAGMA freelist_count').get()!.freelist_count);
            const page = Number(state.db.prepare('PRAGMA page_size').get()!.page_size);
            if (options.compact === true || free * page >= 1024 * 1024) {
              state.db.exec('VACUUM');
              // VACUUM also writes to WAL, so checkpoint after it, not just before.
              state.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
              report.compacted = true;
            }
          }
        } catch (error) {
          if (
            errorCode(error) === 'ERR_SQLITE_ERROR' ||
            (error instanceof Error && error.message.includes('locked'))
          )
            report.compaction_skipped = 'База занята другим процессом; повторите очистку позже.';
          else throw error;
        }
      }
    }
    report.storage = state.storageUsage();
    return report;
  };
  return options.apply
    ? state.lock('maintenance:cleanup', () => state.lock('maintenance:uploads', work))
    : work();
}

export function autoCleanupEnabled() {
  const value = process.env.INSALES_MCP_AUTO_CLEANUP;
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Fault('invalid_config', 'INSALES_MCP_AUTO_CLEANUP должен быть 1 или 0.');
}

export function startAutoCleanup(state: State) {
  if (!autoCleanupEnabled()) return async () => {};
  let running = false;
  let current: Promise<void> | undefined;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const report = await cleanup(state, { apply: true, compact: 'auto' });
      if (report.skipped_uploads && !process.env.INSALES_MCP_UPLOAD_DIR)
        process.stderr.write(`Очистка загрузок MCP: ${report.skipped_uploads}\n`);
      if (report.skipped_downloads && !process.env.INSALES_MCP_DOWNLOAD_DIR)
        process.stderr.write(`Очистка скачиваний MCP: ${report.skipped_downloads}\n`);
    } catch (error) {
      process.stderr.write(
        `Очистка MCP не завершена: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      running = false;
    }
  };
  current = run();
  const timer = setInterval(
    () => {
      current = run();
    },
    60 * 60 * 1000,
  );
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await current;
  };
}
