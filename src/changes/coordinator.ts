import { randomUUID } from 'node:crypto';
import { requiredItem } from '../shared/common.js';
import { prepareResourceWrite } from '../features/content/prepare-write.js';
import { decodeOperation } from '../infrastructure/persistence/codecs.js';
import type { Api } from '../api.js';
import {
  Fault,
  canonical,
  definiteApiRejection,
  errorResult,
  isRecord,
  revision,
  type Json,
} from '../shared/common.js';
import type { ChangeInput } from '../shared/schemas.js';
import { validateFields } from '../shared/validation.js';
import { Catalog } from '../features/catalog/service.js';
import { ProductCatalog } from '../features/products/service.js';
import { Menus } from '../features/menus/service.js';
import { ContentService } from '../features/content/service.js';
import type { Operation, ResourceWrite } from './types.js';

function matches(actual: Json, wanted: Json) {
  return Object.entries(wanted).every(([key, v]) => canonical(actual[key]) === canonical(v));
}
function warningPart(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;
}
export class ChangeCoordinator {
  private readonly content: ContentService;
  readonly api: Api;
  readonly catalog: Catalog;
  readonly products: ProductCatalog;
  readonly menus: Menus;
  constructor(api: Api) {
    this.api = api;
    this.content = new ContentService(api);
    this.catalog = new Catalog(api);
    this.products = new ProductCatalog(api);
    this.menus = new Menus(api);
  }
  client(store: string) {
    return this.content.client(store);
  }
  themeEditor(store: string) {
    return this.content.themeEditor(store);
  }
  read(...args: Parameters<ContentService['read']>) {
    return this.content.read(...args);
  }
  list(...args: Parameters<ContentService['list']>) {
    return this.content.list(...args);
  }
  themeState(...args: Parameters<ContentService['themeState']>) {
    return this.content.themeState(...args);
  }

  private async validateResource(d: ResourceWrite) {
    const results = [];
    for (const item of d.items) {
      const fresh = item.action === 'update' ? await this.read(d.store_id, item.target) : null;
      const conflict = !!fresh && fresh.revision !== item.base_revision;
      const local = await validateFields(item.target, item.fields, item.before);
      results.push({ target: item.target, conflict, ...local });
    }
    return {
      change_id: d.id,
      valid: results.every((r) => !r.conflict && !r.errors.length),
      items: results,
    };
  }
  async runWrite<T>(
    name: string,
    args: Json & { store_id: string; operation_id?: string | undefined },
    write: (id: string) => Promise<T>,
  ) {
    const { operation_id: requestedId, ...input } = args;
    const state = this.api.state;
    state.store(input.store_id);
    const id = requestedId ?? randomUUID();
    const fingerprint = revision({ name, input });
    return state.lock(`operation:${id}`, async () => {
      const saved = state.get(
        'operation',
        id,
        decodeOperation<Operation & { request_fingerprint?: string }>,
      );
      if (saved) {
        const { request_fingerprint, ...result } = saved;
        if (request_fingerprint !== fingerprint)
          throw new Fault('idempotency_key_reused', 'Идентификатор уже связан с другой операцией.');
        return result.status === 'running' || result.status === 'sending'
          ? { ...result, status: 'execution_unknown' }
          : result;
      }
      return state.withWriteFingerprint(id, fingerprint, () => write(id));
    });
  }

  runPublicWrite(name: string, store_id: string, args: Json, call: () => Promise<unknown>) {
    return this.runWrite(name, { ...args, store_id }, (id) =>
      this.api.state.lock(store_id, async () => {
        const operation: Operation & { result?: unknown; error?: unknown } = {
          id,
          store_id,
          status: 'sending',
          items: [],
        };
        this.api.state.put('operation', id, operation);
        try {
          operation.result = await call();
          operation.status = 'applied';
        } catch (error) {
          const info = errorResult(error);
          operation.error = info;
          operation.status =
            definiteApiRejection(info.code) ||
            info.code === 'conflict' ||
            info.code === 'theme_write_restricted' ||
            info.code === 'write_restricted'
              ? 'failed'
              : 'execution_unknown';
        }
        this.api.state.put('operation', id, operation);
        return operation;
      }),
    );
  }

  getOperation(id: string) {
    const op = this.api.state.get('operation', id, decodeOperation<Operation>);
    if (!op) throw new Fault('not_found', 'Операция не найдена.');
    this.api.state.store(op.store_id);
    const { request_fingerprint: _, ...result } = op as Operation & {
      request_fingerprint?: string;
    };
    return result;
  }
  async writeResource(inputs: ChangeInput[], id: string) {
    return this.applyResource(await prepareResourceWrite(this, inputs, id));
  }

  async applyResource(d: ResourceWrite) {
    const id = d.id;
    return this.api.state.lock(d.store_id, async () => {
      const existing = this.api.state.get('operation', id, decodeOperation<Operation>);
      if (existing) {
        // Never resend an interrupted POST/PUT. Read-only reconciliation is safe.
        if (existing.status === 'running' || existing.status === 'execution_unknown') {
          for (let index = 0; index < existing.items.length; index++) {
            const step = requiredItem(existing.items, index);
            const item = requiredItem(d.items, index);
            if (step.status === 'sending' || step.status === 'execution_unknown') {
              const resultId = typeof step.result_id === 'number' ? step.result_id : undefined;
              const target = resultId ? { ...item.target, id: resultId } : item.target;
              if (target.id) {
                try {
                  const current = await this.read(d.store_id, target);
                  if (matches(current.data, item.fields)) {
                    step.status = 'applied';
                    step.result_id = target.id;
                  } else step.status = 'execution_unknown';
                } catch {
                  step.status = 'execution_unknown';
                }
              } else step.status = 'execution_unknown';
            }
          }
          existing.status = existing.items.every((i) => i.status === 'applied')
            ? 'applied'
            : existing.items.some((i) => i.status === 'execution_unknown')
              ? 'execution_unknown'
              : 'partial_failure';
          this.api.state.put('operation', id, existing);
        }
        return existing;
      }
      const check = await this.validateResource(d);
      if (!check.valid)
        throw new Fault(
          check.items.some((i) => i.conflict) ? 'conflict' : 'validation_failed',
          'Проверка изменения не пройдена.',
          { validation: check },
        );
      const op: Operation = {
        id,
        store_id: d.store_id,
        status: 'running',
        items: d.items.map((i) => ({ target: i.target, status: 'pending' })),
      };
      this.api.state.put('operation', id, op);
      for (let index = 0; index < d.items.length; index++) {
        const item = requiredItem(d.items, index);
        const step = requiredItem(op.items, index);
        let sent = false;
        let accepted = false;
        try {
          const current =
            item.action === 'update' ? await this.read(d.store_id, item.target) : null;
          if (current && current.revision !== item.base_revision)
            throw new Fault('conflict', 'Объект изменился перед записью.');
          const fields = { ...item.fields };
          step.status = 'sending';
          this.api.state.put('operation', id, op);
          sent = true;
          const resource = this.client(d.store_id).forTarget(item.target);
          const result =
            item.action === 'create'
              ? await resource.create(fields)
              : await resource.update(item.target.id!, fields);
          accepted = true;
          const resultId = item.target.id ?? Number(result?.id);
          if (!Number.isSafeInteger(resultId) || resultId <= 0)
            throw new Fault('execution_unknown', 'API не вернул идентификатор созданного объекта.');
          step.result_id = resultId;
          this.api.state.put('operation', id, op);
          const after = await this.read(d.store_id, { ...item.target, id: resultId });
          if (!matches(after.data, item.fields))
            throw new Fault(
              'execution_unknown',
              'Сохранённые поля отличаются от запрошенных. Проверьте объект.',
            );
          step.status = 'applied';
          step.revision = after.revision;
        } catch (error) {
          const err = errorResult(error);
          const definitelyRejected = definiteApiRejection(err.code);
          step.status = sent && (accepted || !definitelyRejected) ? 'execution_unknown' : 'failed';
          step.error = err;
          op.status = step.status === 'execution_unknown' ? 'execution_unknown' : 'partial_failure';
          this.api.state.put('operation', id, op);
          return op;
        }
        this.api.state.put('operation', id, op);
      }
      op.status = 'applied';
      this.api.state.put('operation', id, op);
      return op;
    });
  }
}
