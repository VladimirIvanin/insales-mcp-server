import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const VERSION = '1.0.1';
export class Fault extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
const definiteRejections = new Set([
  'validation_failed',
  'permission_denied',
  'request_blocked',
  'payment_required',
  'not_found',
  'rate_limited',
  'authentication_required',
]);
export function definiteApiRejection(code: string) {
  return definiteRejections.has(code);
}
export function errorResult(error: unknown) {
  return error instanceof Fault
    ? { code: error.code, message: error.message, ...error.details }
    : {
        code: 'internal_error',
        message: 'Операция не завершена. Секреты и внутренние ошибки не выводятся.',
      };
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const revision = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export function dataDirectory() {
  if (process.env.INSALES_MCP_DATA_DIR) return resolve(process.env.INSALES_MCP_DATA_DIR);
  return join(ROOT, '.data');
}
export const DEFAULT_UPLOAD_DIRECTORY = join(ROOT, '.uploads');
export function uploadDirectory() {
  const configured = process.env.INSALES_MCP_UPLOAD_DIR;
  if (!configured) return DEFAULT_UPLOAD_DIRECTORY;
  if (!isAbsolute(configured))
    throw new Fault('invalid_config', 'INSALES_MCP_UPLOAD_DIR должен быть абсолютным путём.');
  return resolve(configured);
}
export const DEFAULT_DOWNLOAD_DIRECTORY = join(ROOT, '.downloads');
export function downloadDirectory() {
  const configured = process.env.INSALES_MCP_DOWNLOAD_DIR;
  if (!configured) return DEFAULT_DOWNLOAD_DIRECTORY;
  if (!isAbsolute(configured))
    throw new Fault('invalid_config', 'INSALES_MCP_DOWNLOAD_DIR должен быть абсолютным путём.');
  return resolve(configured);
}
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export type Json = Record<string, unknown>;
export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined)
    throw new Fault('invalid_response', 'Сохранённая операция содержит неполные данные.');
  return item;
}
