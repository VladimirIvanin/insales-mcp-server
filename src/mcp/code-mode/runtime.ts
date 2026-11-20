import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ActiveCalls } from '../../app/active-calls.js';
import { Fault, errorResult, isRecord, revision } from '../../shared/common.js';
import type { State } from '../../infrastructure/persistence/state.js';
import { OperationRegistry } from '../operations.js';
import { ExecutionStore, type Execution, type ExecutionStep } from './store.js';

export const CODE_LIMITS = {
  memoryBytes: 128 * 1024 * 1024,
  cpuMs: 5000,
  wallMs: 60000,
  drainMs: 2000,
  maxCalls: 100,
  readConcurrency: 4,
  bridgeBytes: 16 * 1024 * 1024,
};
const requestSchema = z.object({
  namespace: z.enum(['catalog', 'insales', 'runtime']),
  name: z.string().max(200),
  args: z.unknown(),
});
const terminal = new Set(['conflict', 'partial_failure', 'execution_unknown']);

interface CallSession {
  accepting: boolean;
  callCount: number;
  blocked: unknown;
  write: boolean;
  execution: Execution;
  persist: () => void;
  read: (work: () => Promise<unknown>) => Promise<unknown>;
  mutations: Promise<void>;
}

function bridgeError(error: unknown) {
  if (error instanceof z.ZodError)
    return {
      code: 'validation_failed',
      message: error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; '),
      usage:
        'catalog.search({query, domain?, limit?}); catalog.describe({names:["method_name"]}); runtime.get_execution(id); runtime.get_result(ref,{offset,limit})',
    };
  return errorResult(error);
}

export class CodeRuntime {
  readonly store: ExecutionStore;
  constructor(
    readonly registry: OperationRegistry,
    private readonly state?: State,
    private readonly limits = CODE_LIMITS,
    private readonly calls?: ActiveCalls,
  ) {
    this.store = new ExecutionStore(state);
  }

  execute(code: string, executionId?: string) {
    const write = executionId !== undefined;
    const id = executionId ?? randomUUID();
    const fingerprint = revision(code);
    const work = async () => {
      const saved = this.savedExecution(write, id, fingerprint);
      if (saved) return saved;
      return this.runWorker(code, write, id, fingerprint);
    };
    return write && this.state ? this.state.lock(`code:${id}`, work) : work();
  }

  private savedExecution(write: boolean, id: string, fingerprint: string) {
    if (!write) return;
    const saved = this.store.get('code_execution', id);
    if (saved === undefined) return;
    const execution = this.store.execution(id);
    if (execution.fingerprint !== fingerprint)
      throw new Fault('execution_id_reused', 'execution_id уже связан с другим кодом.');
    return execution;
  }

  private async dispatchCall(session: CallSession, encoded: string): Promise<unknown> {
    if (!session.accepting)
      throw new Fault('execution_closed', 'Исполнение завершено; новые вызовы запрещены.');
    if (++session.callCount > this.limits.maxCalls)
      throw new Fault('call_limit', 'Превышен лимит вызовов методов.');
    if (Buffer.byteLength(encoded) > this.limits.bridgeBytes)
      throw new Fault('request_too_large', 'Аргументы превышают лимит моста.');
    const { namespace, name, args } = requestSchema.parse(JSON.parse(encoded) as unknown);
    if (namespace === 'catalog') {
      if (name === 'search') return this.registry.search(args);
      if (name === 'describe') return this.registry.describe(args);
      throw new Fault('unknown_operation', 'Неизвестный метод каталога.');
    }
    if (namespace === 'runtime') {
      if (name === 'get_execution') {
        const { id } = z.object({ id: z.string().uuid() }).parse(args);
        return this.store.execution(id);
      }
      if (name === 'get_result') {
        const { ref, offset, limit } = z
          .object({
            ref: z.string().uuid(),
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(16000).default(16000),
          })
          .parse(args);
        return this.store.readResult(ref, offset, limit);
      }
      throw new Fault('unknown_operation', 'Неизвестный метод runtime.');
    }
    const operation = this.registry.get(name);
    if (!session.write && operation.effect !== 'read')
      throw new Fault('read_only', 'Этот метод требует execute_write.', { name });
    const invoke = async () => {
      if (!session.accepting)
        throw new Fault('execution_closed', 'Исполнение завершено; новые вызовы запрещены.');
      if (operation.effect !== 'read' && session.blocked)
        throw new Fault('execution_blocked', 'После ошибки дальнейшие изменения запрещены.', {
          cause: session.blocked,
        });
      let actual = args;
      const step: ExecutionStep = { name, effect: operation.effect, status: 'sending' };
      if (
        operation.effect === 'write' &&
        'operation_id' in
          (isRecord(operation.inputSchema.properties) ? operation.inputSchema.properties : {}) &&
        isRecord(args)
      ) {
        const operationId =
          typeof args.operation_id === 'string' ? args.operation_id : randomUUID();
        actual = { ...args, operation_id: operationId };
        step.operation_id = operationId;
      }
      session.execution.steps.push(step);
      session.persist();
      try {
        const result = await operation.invoke(actual);
        step.status =
          isRecord(result) && typeof result.status === 'string' ? result.status : 'completed';
        if (isRecord(result) && typeof result.id === 'string' && operation.effect === 'write')
          step.operation_id = result.id;
        if (
          operation.effect !== 'read' &&
          (['failed', 'error'].includes(step.status) ||
            terminal.has(step.status) ||
            (isRecord(result) && isRecord(result.error) && terminal.has(String(result.error.code))))
        ) {
          session.blocked = result;
          throw new Fault(
            isRecord(result) && isRecord(result.error) && typeof result.error.code === 'string'
              ? result.error.code
              : step.status,
            'Изменение не подтверждено; дальнейшие записи остановлены.',
            { outcome: result },
          );
        }
        session.persist();
        return result;
      } catch (error) {
        step.status = 'error';
        const info = errorResult(error);
        if (operation.effect !== 'read' || terminal.has(info.code)) session.blocked = info;
        session.persist();
        throw error;
      }
    };
    if (operation.effect === 'read') return session.read(invoke);
    const current = session.mutations.then(invoke);
    session.mutations = current.then(
      () => {},
      () => {},
    );
    return current;
  }

  private async runWorker(code: string, write: boolean, id: string, fingerprint: string) {
    const execution: Execution = { execution_id: id, fingerprint, status: 'running', steps: [] };
    const persist = () => {
      if (write) this.store.put('code_execution', id, execution);
    };
    persist();
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { code, cpuMs: this.limits.cpuMs, memoryBytes: this.limits.memoryBytes },
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const pending = new Set<Promise<void>>();
    let unawaited = false;
    let reads = 0;
    const waiting: Array<() => void> = [];
    const session: CallSession = {
      accepting: true,
      callCount: 0,
      blocked: undefined,
      write,
      execution,
      persist,
      mutations: Promise.resolve(),
      read: async (work) => {
        if (reads >= this.limits.readConcurrency)
          await new Promise<void>((resolve) => waiting.push(resolve));
        else reads++;
        try {
          return await work();
        } finally {
          const next = waiting.shift();
          if (next) next();
          else reads--;
        }
      },
    };
    let timer: ReturnType<typeof setTimeout>;
    const outcome = await new Promise<{ ok: boolean; value?: unknown; error?: unknown }>(
      (resolve) => {
        let resolved = false;
        const settle = (value: { ok: boolean; value?: unknown; error?: unknown }) => {
          if (resolved) return;
          resolved = true;
          session.accepting = false;
          unawaited = value.ok && pending.size > 0;
          clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(() => {
          execution.status = 'timed_out';
          settle({
            ok: false,
            error: {
              code: 'execution_timeout',
              message: 'Истекло время исполнения. Не повторяйте записи; проверьте execution_id.',
            },
          });
        }, this.limits.wallMs);
        worker.on('error', (error) =>
          settle({
            ok: false,
            error:
              'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'
                ? { code: 'memory_limit', message: 'Превышен лимит памяти процесса песочницы.' }
                : {
                    code: 'sandbox_error',
                    message: 'Песочница остановлена из-за ошибки или ограничения ресурсов.',
                  },
          }),
        );
        worker.on('exit', () =>
          settle({
            ok: false,
            error: { code: 'sandbox_exit', message: 'Песочница завершилась без результата.' },
          }),
        );
        worker.on('message', (message: unknown) => {
          if (!session.accepting) return;
          if (!isRecord(message)) {
            settle({
              ok: false,
              error: { code: 'invalid_bridge', message: 'Некорректный ответ песочницы.' },
            });
            return;
          }
          if (message.type === 'done' && typeof message.payload === 'string') {
            try {
              if (Buffer.byteLength(message.payload) > this.limits.bridgeBytes) {
                settle({
                  ok: false,
                  error: {
                    code: 'response_too_large',
                    message: 'Итоговый результат превышает лимит моста.',
                  },
                });
                return;
              }
              const result = z
                .object({
                  ok: z.boolean(),
                  value: z.unknown().optional(),
                  error: z.unknown().optional(),
                })
                .parse(JSON.parse(message.payload) as unknown);
              settle(result);
            } catch {
              settle({
                ok: false,
                error: { code: 'invalid_result', message: 'Результат не является JSON.' },
              });
            }
          } else if (
            message.type === 'call' &&
            typeof message.id === 'number' &&
            typeof message.encoded === 'string'
          ) {
            const callId = message.id;
            const encoded = message.encoded;
            const task = (async () => {
              let reply: string;
              try {
                const value = await this.dispatchCall(session, encoded);
                if (!session.accepting) return;
                reply = JSON.stringify({ ok: true, value: value ?? null });
                if (Buffer.byteLength(reply) > this.limits.bridgeBytes)
                  throw new Fault('response_too_large', 'Результат метода превышает лимит моста.');
              } catch (error) {
                if (!session.accepting) return;
                reply = JSON.stringify({ ok: false, error: bridgeError(error) });
              }
              if (session.accepting) worker.postMessage({ id: callId, encoded: reply });
            })();
            pending.add(task);
            void task.then(
              () => pending.delete(task),
              () => {
                pending.delete(task);
                settle({
                  ok: false,
                  error: {
                    code: 'invalid_bridge',
                    message: 'Не удалось передать ответ в песочницу.',
                  },
                });
              },
            );
          } else
            settle({
              ok: false,
              error: { code: 'invalid_bridge', message: 'Неизвестное сообщение песочницы.' },
            });
        });
      },
    );
    const termination = worker.terminate();
    if (pending.size) {
      const draining = Promise.allSettled([...pending]);
      const tracked = this.calls?.track(draining) ?? draining;
      const grace = new AbortController();
      try {
        await Promise.race([
          tracked,
          delay(this.limits.drainMs, undefined, { signal: grace.signal }),
        ]);
      } finally {
        grace.abort();
      }
    }
    await termination;
    const error =
      execution.status === 'timed_out'
        ? outcome.error
        : unawaited
          ? {
              code: 'unawaited_calls',
              message:
                'Скрипт завершился с незавершёнными вызовами. Используйте await; отправленные изменения отражены в steps.',
            }
          : (session.blocked ?? outcome.error);
    if (execution.status !== 'timed_out')
      execution.status = outcome.ok && !unawaited && !session.blocked ? 'completed' : 'error';
    try {
      if (outcome.ok) this.store.result(outcome.value, execution, write);
      if (execution.status !== 'completed') this.store.error(error, execution, write);
      if (Buffer.byteLength(JSON.stringify(execution)) > 64 * 1024 && 'result' in execution) {
        const value = execution.result;
        delete execution.result;
        this.store.result(value, execution, write, true);
      }
      persist();
    } catch (error) {
      const info = errorResult(error);
      throw new Fault(info.code, info.message, { execution_id: id, outcome: 'unknown' });
    }
    return pending.size ? structuredClone(execution) : execution;
  }
}
