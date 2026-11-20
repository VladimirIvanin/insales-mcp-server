import { createHash } from 'node:crypto';
import { normalizeUrl } from '../api.js';
import { MCP_ACCESS, type McpAccess } from '../infrastructure/insales/write-access.js';
import { Fault } from '../shared/common.js';
import type { Store } from '../infrastructure/persistence/state.js';

export interface Credentials {
  key: string;
  password: string;
}

export interface RuntimeConfig {
  store: Store;
  credentials: Credentials;
}

const REQUIRED = ['INSALES_STORE_URL', 'INSALES_API_KEY_ID', 'INSALES_API_KEY_PASSWORD'] as const;

export function configFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig | undefined {
  const anyConfigured = REQUIRED.some((name) => environment[name] !== undefined);
  if (!anyConfigured) return undefined;

  const missing = REQUIRED.filter((name) => !environment[name]);
  if (missing.length) {
    throw new Fault('invalid_config', 'Не заданы обязательные переменные окружения MCP.', {
      missing,
    });
  }

  const url = normalizeUrl(environment.INSALES_STORE_URL!.trim());
  const key = environment.INSALES_API_KEY_ID!.trim();
  const password = environment.INSALES_API_KEY_PASSWORD!;
  if (!key || key.includes(':') || !password)
    throw new Fault('invalid_config', 'Некорректные API-реквизиты InSales.');

  const id = `configured-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
  const name = environment.INSALES_STORE_NAME?.trim() || new URL(url).hostname;
  return {
    store: {
      id,
      name,
      url,
    },
    credentials: { key, password },
  };
}

export function mcpOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const mode = environment.INSALES_MCP_MODE ?? 'code';
  const fullApi = environment.INSALES_MCP_FULL_API ?? 'false';
  const access = environment.INSALES_MCP_ACCESS ?? 'full';
  const theme = environment.INSALES_MCP_THEME_ID?.trim();
  if (mode !== 'code' && mode !== 'tools')
    throw new Fault('invalid_config', 'INSALES_MCP_MODE должен быть code или tools.');
  if (!['true', 'false', '1', '0'].includes(fullApi))
    throw new Fault('invalid_config', 'INSALES_MCP_FULL_API должен быть true/false или 1/0.');
  if (!MCP_ACCESS.includes(access as McpAccess))
    throw new Fault('invalid_config', 'INSALES_MCP_ACCESS должен быть full или theme_files.');
  if (theme && (!/^[1-9][0-9]*$/.test(theme) || !Number.isSafeInteger(Number(theme))))
    throw new Fault('invalid_config', 'INSALES_MCP_THEME_ID должен быть положительным целым ID.');
  return {
    mode,
    fullApi: fullApi === 'true' || fullApi === '1',
    access: access as McpAccess,
    themeId: theme ? Number(theme) : undefined,
  } as const;
}

export type McpOptions = ReturnType<typeof mcpOptionsFromEnvironment>;
