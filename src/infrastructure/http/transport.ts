import dns from 'node:dns';
import type { LookupOptions } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import { Fault, isRecord, type Json } from '../../shared/common.js';
import { apiPathForLog, type ApiErrorLog } from '../logging/api-error-log.js';
import type { Store } from '../persistence/state.js';
import type { Credentials } from '../../app/config.js';

export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function normalizeUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    throw new Fault('validation_failed', 'Укажите HTTPS-домен магазина.');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Fault(
      'validation_failed',
      'Нужен HTTPS-домен без пути, порта, параметров и реквизитов.',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (ipaddr.isValid(host) && !publicAddress(host))
  )
    throw new Fault('validation_failed', 'Нужен публичный адрес магазина.');
  return url.origin;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

// Pin resolution to validated addresses at connection time, not only at onboarding.
export function validatedLookup(allow: (address: string) => boolean) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!addresses.length || addresses.some((item) => !allow(item.address)))
        return callback(new Error('Rejected address'), '');
      if (options.all) callback(null, addresses);
      else {
        const first = addresses[0];
        if (!first) callback(new Error('Rejected address'), '');
        else callback(null, first.address, first.family);
      }
    });
  };
}
function validatedDispatcher(allow: (address: string) => boolean) {
  return new Agent({ connect: { lookup: validatedLookup(allow) } });
}
// URL снимает сегменты «.» и «..». Имя с «..» внутри остаётся, путь вне /admin/ отклоняется.
function adminPath(path: string) {
  let url: URL;
  try {
    url = new URL(path, 'https://api.invalid');
  } catch {
    throw new Fault('validation_failed', 'Недопустимый API-путь.');
  }
  if (
    url.origin !== 'https://api.invalid' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith('/admin/')
  )
    throw new Fault('validation_failed', 'Недопустимый API-путь.');
  return url.pathname + url.search;
}
export function appendQuery(query: URLSearchParams, key: string, value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(query, `${key}[]`, item);
  } else if (isRecord(value)) {
    for (const [child, item] of Object.entries(value)) appendQuery(query, `${key}[${child}]`, item);
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    query.append(key, String(value));
  } else throw new Fault('validation_failed', 'Некорректный параметр query.');
}
export interface Transport {
  request(
    store: Store,
    credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options?: RequestOptions,
  ): Promise<unknown>;
  close?(): Promise<void>;
}
export interface RawBody {
  bytes: Buffer;
  contentType?: string;
}
export function isRawBody(value: unknown): value is RawBody {
  return (
    isRecord(value) &&
    Buffer.isBuffer(value.bytes) &&
    (value.contentType === undefined || typeof value.contentType === 'string')
  );
}
export interface RequestOptions {
  timeoutMs?: number;
  raw?: 'bytes';
  idempotencyKey?: string;
  acceptUnprocessable?: boolean;
}
function sanitizeMessage(value: string) {
  return (
    value
      .replace(/\b(?:https?|ftp):\/\/[^\s<>"']+/gi, '[URL]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '[credential]')
      .replace(
        /\b(?:password|passwd|token|api[_-]?key|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
        '[credential]',
      )
      // Control characters must not reach the MCP result or local log.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 160)
  );
}
const validationField = /^[a-z][a-z0-9_.[\]]{0,127}$/i;

function validationErrors(parsed: unknown): { field: string; message: string }[] {
  if (!isRecord(parsed)) return [];
  const source =
    'errors' in parsed && parsed.errors && typeof parsed.errors === 'object'
      ? parsed.errors
      : parsed;
  const result: { field: string; message: string }[] = [];
  if (Array.isArray(source)) {
    for (const rawItem of source.slice(0, 12) as unknown[]) {
      if (!isRecord(rawItem)) continue;
      const field =
        typeof rawItem.path === 'string'
          ? rawItem.path
          : typeof rawItem.field === 'string'
            ? rawItem.field
            : '';
      const value = typeof rawItem.message === 'string' ? rawItem.message : '';
      if (!validationField.test(field) || !value) continue;
      const message = sanitizeMessage(value);
      if (message) result.push({ field, message });
    }
    return result;
  }
  if (!isRecord(source)) return result;
  for (const [field, messages] of Object.entries(source).slice(0, 8)) {
    if (!validationField.test(field)) continue;
    for (const value of (Array.isArray(messages) ? messages : [messages]).slice(0, 3)) {
      if (typeof value !== 'string') continue;
      const message = sanitizeMessage(value);
      if (message) result.push({ field, message });
    }
  }
  return result;
}

function retryAfterSeconds(header: string | null) {
  const bounded = (seconds: number) => Math.min(3600, seconds);
  if (!header) return 60;
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isFinite(seconds) ? bounded(seconds) : 60;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(header)) return 60;
  const date = Date.parse(header);
  return Number.isFinite(date) ? bounded(Math.max(1, (date - Date.now()) / 1000)) : 60;
}

const knownRejection = new Set([401, 403, 404, 409, 422, 429]);

export function classifyHttpStatus(status: number, write: boolean, data?: unknown) {
  const codes: Record<number, string> = {
    401: 'authentication_required',
    403: 'permission_denied',
    402: 'payment_required',
    404: 'not_found',
    409: 'conflict',
    422: 'validation_failed',
    429: 'rate_limited',
  };
  if (isRecord(data)) {
    if (data.code === 'idempotency_in_progress') return 'execution_unknown';
    if (
      write &&
      (data.outcome === 'unknown' ||
        (isRecord(data.details) && data.details.outcome === 'unknown') ||
        ['idempotency_result_unknown', 'idempotency_in_progress'].includes(String(data.reason)))
    )
      return 'execution_unknown';
    if (
      typeof data.code === 'string' &&
      [
        'live_theme_selection_required',
        'asset_batch_not_supported',
        'idempotency_unavailable',
      ].includes(data.code)
    )
      return data.code === 'idempotency_unavailable' && write ? 'execution_unknown' : data.code;
  }
  return codes[status] ?? (write && status >= 500 ? 'execution_unknown' : 'api_error');
}

const transportFailures: Record<string, { reason: string; message: string }> = {
  UND_ERR_CONNECT_TIMEOUT: {
    reason: 'connect_timeout',
    message: 'Истекло время ожидания подключения к магазину.',
  },
  UND_ERR_HEADERS_TIMEOUT: {
    reason: 'response_timeout',
    message: 'Магазин не прислал заголовки ответа вовремя.',
  },
  ENOTFOUND: { reason: 'dns_failure', message: 'Не удалось найти адрес магазина через DNS.' },
  EAI_AGAIN: { reason: 'dns_failure', message: 'DNS временно не ответил при поиске магазина.' },
  ECONNREFUSED: { reason: 'connection_refused', message: 'Магазин отклонил соединение.' },
  ECONNRESET: { reason: 'connection_reset', message: 'Соединение с магазином было сброшено.' },
  UND_ERR_SOCKET: { reason: 'connection_reset', message: 'Соединение с магазином было прервано.' },
  TimeoutError: { reason: 'request_timeout', message: 'Истекло время ожидания ответа магазина.' },
  AbortError: { reason: 'request_timeout', message: 'Истекло время ожидания ответа магазина.' },
};

export class HttpTransport implements Transport {
  private logWarningSent = false;
  private readonly publicDispatcher = validatedDispatcher(publicAddress);
  constructor(
    private usage?: (store: Store, used: number, total: number) => void,
    private fetchImpl: typeof fetch = fetch,
    private errorLog?: ApiErrorLog,
  ) {}
  async close() {
    await this.publicDispatcher.close();
  }
  request(
    store: Store,
    credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: Json | undefined,
    options: RequestOptions & { raw: 'bytes' },
  ): Promise<RawBody>;
  request(
    store: Store,
    credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options?: RequestOptions,
  ): Promise<unknown>;
  async request(
    store: Store,
    credentials: Credentials,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const apiPath = adminPath(path);
    if (
      options.idempotencyKey !== undefined &&
      (!options.idempotencyKey ||
        options.idempotencyKey.length > 200 ||
        /[\r\n]/.test(options.idempotencyKey))
    ) {
      throw new Fault('validation_failed', 'Некорректный Idempotency-Key.');
    }
    const started = Date.now();
    let phase = 'connect';
    let httpStatus: number | undefined;
    let responseContentType: string | undefined;
    let responseBytes: number | undefined;
    let requestId: string | undefined;
    let transportError: string | undefined;
    try {
      let response;
      try {
        response = await this.fetchImpl(normalizeUrl(store.url) + apiPath, {
          dispatcher: this.publicDispatcher,
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(`${credentials.key}:${credentials.password}`).toString('base64'),
            Accept: options.raw === 'bytes' ? '*/*' : 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
        transportError =
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
            ? code
            : error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
              ? error.name
              : undefined;
        const failure =
          transportError && Object.hasOwn(transportFailures, transportError)
            ? transportFailures[transportError]
            : undefined;
        throw new Fault(
          method === 'GET' ? 'connection_failed' : 'execution_unknown',
          failure?.message ?? 'Не удалось подтвердить ответ магазина.',
          {
            reason: failure?.reason ?? 'transport_failure',
            ...(failure ? { transport_error: transportError } : {}),
          },
        );
      }
      httpStatus = response.status;
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType))
        responseContentType = contentType;
      const upstreamRequestId =
        response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id');
      if (upstreamRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(upstreamRequestId))
        requestId = upstreamRequestId;
      const usage = response.headers.get('api-usage-limit')?.match(/(\d+)\s*\/\s*(\d+)/);
      if (usage) this.usage?.(store, Number(usage[1]), Number(usage[2]));
      let bytes = Buffer.alloc(0);
      let bodyRead = true;
      phase = 'read_response';
      try {
        if (response.body === null) responseBytes = 0;
        else {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const rawChunk of response.body) {
            const chunk: unknown = rawChunk;
            if (!(chunk instanceof Uint8Array)) throw new Error('Invalid response chunk');
            size += chunk.length;
            responseBytes = size;
            if (size > 8 * 1024 * 1024) throw new Error('Response too large');
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
        }
      } catch {
        bodyRead = false;
      }
      const text = bytes.toString('utf8');
      const status = response.status;
      if (!bodyRead) {
        if (knownRejection.has(status)) {
          phase = 'http_status';
          throw new Fault(
            classifyHttpStatus(status, method !== 'GET'),
            `InSales вернул HTTP ${status}.`,
            {
              http_status: status,
              ...(status === 429
                ? { retry_after_seconds: retryAfterSeconds(response.headers.get('retry-after')) }
                : {}),
            },
          );
        }
        throw new Fault(
          method === 'GET' ? 'invalid_response' : 'execution_unknown',
          'Не удалось прочитать ответ магазина.',
        );
      }
      if (status === 422 && options.acceptUnprocessable) {
        try {
          return text ? JSON.parse(text) : { valid: false, errors: [] };
        } catch {
          throw new Fault('invalid_response', 'InSales вернул некорректный результат проверки.');
        }
      }
      if (!response.ok) {
        phase = 'http_status';
        let parsed: unknown;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
        }
        const code = classifyHttpStatus(status, method !== 'GET', parsed);
        const errors = status === 422 && text.length <= 16 * 1024 ? validationErrors(parsed) : [];
        throw new Fault(code, `InSales вернул HTTP ${status}.`, {
          http_status: status,
          ...(errors.length ? { validation_errors: errors } : {}),
          ...(status === 429
            ? { retry_after_seconds: retryAfterSeconds(response.headers.get('retry-after')) }
            : {}),
        });
      }
      try {
        phase = 'parse_response';
        if (options.raw === 'bytes')
          return { bytes, ...(responseContentType ? { contentType: responseContentType } : {}) };
        const data: unknown = text ? JSON.parse(text) : {};
        if (data && typeof data === 'object' && 'status' in data && data.status === 'error')
          throw new Fault('validation_failed', 'InSales сообщил об ошибке в теле ответа.');
        return data;
      } catch (error) {
        if (error instanceof Fault) throw error;
        throw new Fault(
          method === 'GET' ? 'invalid_response' : 'execution_unknown',
          'Не удалось прочитать ответ магазина.',
        );
      }
    } catch (error) {
      if (this.errorLog) {
        try {
          this.errorLog.record({
            store_id: store.id,
            store_host: new URL(store.url).hostname,
            method,
            path: apiPathForLog(path),
            code: error instanceof Fault ? error.code : 'internal_error',
            phase,
            duration_ms: Date.now() - started,
            ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
            ...(responseContentType ? { response_content_type: responseContentType } : {}),
            ...(responseBytes === undefined ? {} : { response_bytes: responseBytes }),
            ...(requestId ? { request_id: requestId } : {}),
            ...(transportError ? { transport_error: transportError } : {}),
          });
        } catch {
          if (!this.logWarningSent)
            process.stderr.write('Не удалось записать журнал ошибок InSales API.\n');
          this.logWarningSent = true;
        }
      }
      throw error;
    }
  }
}
