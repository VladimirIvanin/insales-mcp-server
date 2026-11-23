import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fault } from '../../shared/common.js';

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
const FILE_NAME = /^api-errors-\d{4}-\d{2}-\d{2}\.jsonl$/;

export interface ApiErrorEvent {
  store_id: string;
  store_host: string;
  method: string;
  path: string;
  code: string;
  phase: string;
  duration_ms: number;
  http_status?: number;
  response_content_type?: string;
  response_bytes?: number;
  request_id?: string;
  support_id?: string;
  transport_error?: string;
}

export function apiErrorLogEnabled(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.INSALES_MCP_API_ERROR_LOG;
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Fault('invalid_config', 'INSALES_MCP_API_ERROR_LOG должен быть 1 или 0.');
}

// Query values can contain search terms or credentials. Keep only known numeric selectors
// and the inventory view; never persist request bodies, response bodies, or headers.
export function apiPathForLog(path: string) {
  const url = new URL(path, 'https://api.invalid');
  const safe = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) continue;
    const numeric =
      /^(?:page|per_page|theme_id|widget_list_id|placement_id)$/.test(key) &&
      /^\d{1,18}$/.test(value);
    safe.append(key, numeric || (key === 'view' && value === 'inventory') ? value : '[redacted]');
  }
  return (url.pathname + (safe.size ? `?${safe}` : '')).slice(0, 2048);
}

export class ApiErrorLog {
  constructor(
    readonly directory: string,
    now = Date.now(),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory())
      throw new Fault('invalid_config', 'Каталог API-логов должен быть обычным каталогом.');
    chmodSync(directory, 0o700);
    this.prune(now);
  }

  prune(now = Date.now()) {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !FILE_NAME.test(entry.name)) continue;
      const file = join(this.directory, entry.name);
      if (statSync(file).mtimeMs < now - THREE_DAYS) unlinkSync(file);
    }
  }

  record(event: ApiErrorEvent, now = Date.now()) {
    const timestamp = new Date(now).toISOString();
    const file = join(this.directory, `api-errors-${timestamp.slice(0, 10)}.jsonl`);
    appendFileSync(file, JSON.stringify({ timestamp, ...event }) + '\n', {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  }
}

export function startApiErrorLog(
  environment: NodeJS.ProcessEnv = process.env,
  directory = join(tmpdir(), `insales-mcp-api-errors-${process.getuid?.() ?? 'user'}`),
) {
  return apiErrorLogEnabled(environment) ? new ApiErrorLog(directory) : undefined;
}
