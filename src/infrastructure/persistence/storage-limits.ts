import { Fault } from '../../shared/common.js';

const MIB = 1024 * 1024;

export interface StorageLimits {
  databaseBytes: number;
  walBytes: number;
  recordBytes: number;
  records: number;
  uploadBytes: number;
  uploadFiles: number;
}

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
    throw new Fault('invalid_config', `${name} должен быть положительным целым числом.`);
  return value;
}

export function storageLimits(): StorageLimits {
  const result = {
    databaseBytes: positiveInteger('INSALES_MCP_MAX_DATABASE_MB', 128) * MIB,
    walBytes: positiveInteger('INSALES_MCP_MAX_WAL_MB', 32) * MIB,
    recordBytes: positiveInteger('INSALES_MCP_MAX_RECORD_MB', 16) * MIB,
    records: positiveInteger('INSALES_MCP_MAX_RECORDS', 2000),
    uploadBytes: positiveInteger('INSALES_MCP_MAX_UPLOAD_MB', 512) * MIB,
    uploadFiles: positiveInteger('INSALES_MCP_MAX_UPLOAD_FILES', 2000),
  };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value)))
    throw new Fault('invalid_config', 'Лимит хранилища слишком велик.');
  return result;
}

export function storageLimit(resource: string, limit: number, actual: number) {
  return new Fault(
    'storage_limit_exceeded',
    'Достигнут лимит локального хранилища MCP. Выполните npm run cleanup -- --apply или увеличьте лимит; сохранённые операции не удаляются для освобождения места.',
    { resource, limit, actual },
  );
}
