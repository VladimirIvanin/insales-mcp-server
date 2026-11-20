import { randomUUID } from 'node:crypto';
import type { Api } from '../../api.js';
import {
  Fault,
  canonical,
  definiteApiRejection,
  errorResult,
  isRecord,
  type Json,
} from '../../shared/common.js';
import { appendQuery } from '../../infrastructure/http/transport.js';
import { decodeAssetBody, presentThemeAsset } from './asset-body.js';
import { themeResourceContract } from './resource-contract.js';

type Method = (typeof themeResourceContract)[number];
interface ResourceOperation {
  id: string;
  store_id: string;
  method_id: string;
  path: string;
  method: Method['method'];
  body: Json;
  items: Json[];
  fingerprint: string;
  expires_at: number;
  idempotency_key?: string;
  status: 'sending' | 'applied' | 'failed' | 'execution_unknown';
  result?: unknown;
  error?: unknown;
}

function decodeOperation(value: unknown): ResourceOperation {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.store_id !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.method !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    typeof value.expires_at !== 'number' ||
    !isRecord(value.body) ||
    typeof value.status !== 'string'
  ) {
    throw new Fault('invalid_response', 'Повреждён журнал операции темы.');
  }
  return value as unknown as ResourceOperation;
}

export class DirectThemeResources {
  constructor(private readonly api: Api) {}

  async execute(
    method: Method,
    store: string,
    pathArgs: Json,
    body: Json = {},
    operationId?: string,
  ) {
    this.api.state.store(store);
    let path = method.path.replace(/:([a-z_]+)/g, (_, field: string) => {
      const value = pathArgs[field];
      if (field === 'job_id') {
        if (
          typeof value !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
        )
          throw new Fault('validation_failed', 'Нужен job_id в формате UUID.');
        return value;
      }
      if (
        field === 'id' &&
        ['target-system-types-show', 'target-snippets-show'].includes(method.id) &&
        typeof value === 'string'
      ) {
        if (!/^[a-zA-Z0-9_-]+$/.test(value))
          throw new Fault('validation_failed', 'Некорректный handle системного ресурса.');
        return value;
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        throw new Fault('validation_failed', `Нужен положительный ${field}.`);
      return String(value);
    });
    if (method.method === 'GET') {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        appendQuery(query, key, value);
      }
      if (query.size) path += `?${query}`;
      if (method.id === 'target-assets-raw')
        return decodeAssetBody(
          await this.api.requestUnknown(store, 'GET', path, undefined, { raw: 'bytes' }),
        );
      const data = await this.api.requestUnknown(store, 'GET', path);
      if (method.id === 'target-assets-show') return presentThemeAsset(data);
      return data;
    }
    if (path.startsWith('/admin/theme_editor/v1/')) {
      const allowed = new Set<string>(
        method.request_fields
          .filter((field) => field.location === 'JSON')
          .map((field) => field.name.split(/[.[]/)[0]!),
      );
      for (const key of Object.keys(body)) {
        if (!allowed.has(key))
          throw new Fault(
            'validation_failed',
            `Параметр ${key} не поддерживается этим методом API.`,
          );
      }
    }
    if (method.read_only) return this.api.requestUnknown(store, method.method, path, body);
    this.api.checkThemeWrite(method.method, path);
    body = this.prepareWriteBody(method, body);
    this.validateObjects(body);
    const id = operationId ?? randomUUID();
    const fingerprint = canonical({ method: method.method, path, body });
    const saved = this.api.state.get('operation', id, decodeOperation);
    if (saved) {
      if (saved.store_id !== store || saved.fingerprint !== fingerprint)
        throw new Fault(
          'idempotency_key_reused',
          'Идентификатор операции уже связан с другим запросом.',
        );
      return this.retry(id);
    }
    const operation: ResourceOperation = {
      id,
      store_id: store,
      method_id: method.id,
      path,
      method: method.method,
      body,
      items: [],
      fingerprint,
      expires_at: Date.now() + 3600000,
      status: 'sending',
      ...(method.idempotent ? { idempotency_key: id } : {}),
    };
    return this.send(operation);
  }

  async retry(id: string) {
    const operation = this.api.state.get('operation', id, decodeOperation);
    if (!operation) throw new Fault('not_found', 'Операция темы не найдена.');
    this.api.state.store(operation.store_id);
    if (operation.status === 'applied' || operation.status === 'failed') return operation;
    const method = themeResourceContract.find((method) => method.id === operation.method_id);
    if (!method?.idempotent || !operation.idempotency_key || operation.expires_at <= Date.now())
      throw new Fault(
        'execution_unknown',
        'Повторная запись не разрешена: прочитайте текущее состояние.',
        { operation_id: id },
      );
    return this.send(operation);
  }

  private async send(operation: ResourceOperation) {
    this.api.checkThemeWrite(operation.method, operation.path);
    return this.api.state.lock(operation.store_id, async () => {
      operation.status = 'sending';
      this.api.state.put('operation', operation.id, operation);
      try {
        operation.result = await this.api.requestUnknown(
          operation.store_id,
          operation.method,
          operation.path,
          operation.body,
          operation.idempotency_key ? { idempotencyKey: operation.idempotency_key } : undefined,
        );
        operation.status = 'applied';
      } catch (error) {
        const info = errorResult(error);
        operation.error = info;
        operation.status =
          definiteApiRejection(info.code) || info.code === 'conflict'
            ? 'failed'
            : 'execution_unknown';
      }
      this.api.state.put('operation', operation.id, operation);
      return operation;
    });
  }

  private validateObjects(body: Json) {
    for (const key of [
      'name',
      'settings_form',
      'settings_data',
      'setup',
      'messages',
      'block_settings_presets',
    ]) {
      if (key !== 'name' && key in body && !isRecord(body[key]))
        throw new Fault('validation_failed', `${key} должен быть JSON-объектом.`);
    }
  }

  private prepareWriteBody(method: Method, body: Json): Json {
    if (['target-types-create', 'target-types-update', 'target-types-copy'].includes(method.id)) {
      if (
        'handle' in body &&
        (typeof body.handle !== 'string' || !body.handle || /[^a-zA-Z0-9_-]/.test(body.handle))
      )
        throw new Fault(
          'validation_failed',
          'handle типа виджета: только латинские буквы, цифры, _ и -.',
        );
    }

    if (
      ['target-blocks-create', 'target-widget-blocks-create', 'target-block-items-add'].includes(
        method.id,
      )
    ) {
      return this.normalizeBlockTitle(body, true, 'title');
    }
    if (['target-blocks-update', 'target-widget-blocks-update'].includes(method.id)) {
      return this.normalizeBlockTitle(body, false, 'title');
    }
    if (['target-widget-blocks-replace', 'target-block-lists-replace'].includes(method.id)) {
      const key = method.id === 'target-widget-blocks-replace' ? 'blocks' : 'items';
      const blocks = body[key];
      if (!Array.isArray(blocks))
        throw new Fault('validation_failed', `${key} должен быть массивом блоков.`);
      return {
        ...body,
        [key]: blocks.map((block: unknown, index) => {
          if (!isRecord(block))
            throw new Fault('validation_failed', `${key}[${index}] должен быть объектом.`);
          return this.normalizeBlockTitle(block, !block.id, `${key}[${index}].title`);
        }),
      };
    }
    return body;
  }

  private normalizeBlockTitle(block: Json, required: boolean, path: string): Json {
    if (!required && !('title' in block)) return block;
    const title: unknown = typeof block.title === 'string' ? { ru: block.title } : block.title;
    if (
      !isRecord(title) ||
      !Object.values(title).every((value) => typeof value === 'string') ||
      !Object.values(title).some((value) => typeof value === 'string' && value.trim())
    )
      throw new Fault(
        'validation_failed',
        `${path}: нужно непустое название или объект переводов locale → string.`,
      );
    return { ...block, title };
  }
}
