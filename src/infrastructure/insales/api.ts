import { fetch } from 'undici';
import { Fault, isRecord, sleep, type Json } from '../../shared/common.js';
import type { Credentials } from '../../app/config.js';
import type { State } from '../persistence/state.js';
import type { ApiErrorLog } from '../logging/api-error-log.js';
import {
  HttpTransport,
  isRawBody,
  type RawBody,
  type Transport,
  type RequestOptions,
} from '../http/transport.js';
import { themeFilesWriteAllowed, type McpAccess } from './write-access.js';

export class Api {
  private transport: Transport;
  constructor(
    public state: State,
    private credentials?: Credentials,
    transport?: Transport,
    errorLog?: ApiErrorLog,
    private readonly themeId?: number,
    private readonly access: McpAccess = 'full',
  ) {
    this.transport =
      transport ??
      new HttpTransport(
        (store, used, total) => {
          if (total > 0 && used >= total - 2) this.state.defer(store.url, 300000);
        },
        fetch,
        errorLog,
      );
  }
  checkAccess(method: string, path: string) {
    if (this.access !== 'theme_files' || method === 'GET') return;
    if (themeFilesWriteAllowed(path)) return;
    throw new Fault(
      'write_restricted',
      'В режиме theme_files запись разрешена только для тем и файлов.',
      { allowed: ['/admin/theme_editor/v1', '/admin/themes', '/admin/files'] },
    );
  }

  checkThemeWrite(method: string, path: string) {
    if (this.themeId === undefined || method === 'GET') return;
    const pathname = new URL(path, 'https://api.invalid').pathname;
    if (
      method === 'POST' &&
      /^\/admin\/theme_editor\/v1\/themes\/[1-9][0-9]*\/(?:profile|page_widgets|widgets\/[1-9][0-9]*\/render)\.json$/.test(
        pathname,
      )
    )
      return;

    const target = /^\/admin\/(?:theme_editor\/v1\/)?themes(?:\/([^/.]+))?(?:\/|\.|$)/.exec(
      pathname,
    );
    if (!target) return;
    const changesActiveTheme =
      /^\/admin\/(?:theme_editor\/v1\/)?themes\/[^/]+\/(?:publish|duplicate)\.json$/.test(pathname);
    if (target[1] !== String(this.themeId) || changesActiveTheme) {
      throw new Fault(
        'theme_write_restricted',
        'Запись запрещена настройкой INSALES_MCP_THEME_ID.',
        {
          theme_id: this.themeId,
        },
      );
    }
  }

  async requestUnknown(
    storeId: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: Json | undefined,
    options: RequestOptions & { raw: 'bytes' },
  ): Promise<RawBody>;
  async requestUnknown(
    storeId: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options?: RequestOptions,
  ): Promise<unknown>;
  async requestUnknown(
    storeId: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options: RequestOptions = {},
  ): Promise<unknown> {
    this.checkAccess(method, path);
    this.checkThemeWrite(method, path);
    const store = this.state.store(storeId);
    if (!this.credentials)
      throw new Fault('authentication_required', 'Задайте credentials в окружении MCP-процесса.');
    const delay = this.state.rateSlot(store.url);
    if (delay > 15000)
      throw new Fault('rate_limited', 'Дождитесь освобождения лимита API.', {
        retry_after_seconds: Math.ceil(delay / 1000),
      });
    if (delay > 0) await sleep(delay);
    try {
      const response = await this.transport.request(
        store,
        this.credentials,
        method,
        path,
        body,
        options,
      );
      if (options.raw === 'bytes') {
        if (!isRawBody(response))
          throw new Fault('invalid_response', 'InSales вернул некорректный файл.');
        return response;
      }
      return response;
    } catch (error) {
      if (error instanceof Fault && error.code === 'rate_limited')
        this.state.defer(store.url, Number(error.details.retry_after_seconds) * 1000);
      throw error;
    }
  }
  async request(
    storeId: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options?: RequestOptions,
  ): Promise<unknown> {
    return this.requestUnknown(storeId, method, path, body, options);
  }
  async requestObject(
    storeId: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: Json,
    options?: RequestOptions,
  ): Promise<Json> {
    const response = await this.requestUnknown(storeId, method, path, body, options);
    if (!isRecord(response)) throw new Fault('invalid_response', 'InSales вернул не объект.');
    return response;
  }
  async requestObjects(
    storeId: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
  ): Promise<Json[]> {
    const response = await this.requestUnknown(storeId, method, path);
    if (!Array.isArray(response) || !response.every(isRecord))
      throw new Fault('invalid_response', 'InSales вернул не список объектов.');
    return response;
  }
  async close() {
    await this.transport.close?.();
  }
}
