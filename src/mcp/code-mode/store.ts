import { randomUUID } from 'node:crypto';
import type { State } from '../../infrastructure/persistence/state.js';
import { Fault, isRecord } from '../../shared/common.js';

export interface ExecutionStep {
  name: string;
  effect: string;
  status: string;
  operation_id?: string;
  change_id?: string;
}
export interface Execution {
  execution_id: string;
  fingerprint: string;
  status: 'running' | 'completed' | 'error' | 'timed_out' | 'expired';
  steps: ExecutionStep[];
  result?: unknown;
  result_ref?: string;
  error?: unknown;
  error_ref?: string;
}

export class ExecutionStore {
  private readonly memory = new Map<string, { time: number; value: unknown }>();
  constructor(private readonly state?: State) {}

  put(kind: string, id: string, value: unknown) {
    if (this.state) this.state.put(kind, id, value);
    else {
      if (this.memory.size >= 2000 && !this.memory.has(`${kind}:${id}`))
        throw new Fault('storage_limit_exceeded', 'Достигнут лимит записей runtime.');
      this.memory.set(`${kind}:${id}`, { time: Date.now(), value: structuredClone(value) });
    }
  }
  get(kind: string, id: string): unknown {
    return this.state
      ? this.state.get(kind, id, (value) => value)
      : this.memory.get(`${kind}:${id}`)?.value;
  }
  execution(id: string): Execution {
    const value = this.get('code_execution', id);
    if (
      !isRecord(value) ||
      value.execution_id !== id ||
      !Array.isArray(value.steps) ||
      typeof value.fingerprint !== 'string'
    )
      throw new Fault('not_found', 'Запуск не найден.');
    return value as unknown as Execution;
  }
  result(value: unknown, execution: Execution, persistent: boolean, forceReference = false) {
    const serialized = JSON.stringify(value ?? null);
    if (!forceReference && Buffer.byteLength(serialized) <= 48 * 1024)
      execution.result = value ?? null;
    else {
      const ref = randomUUID();
      this.put(persistent ? 'code_result' : 'code_read_result', ref, {
        serialized,
        created_at: Date.now(),
      });
      execution.result_ref = ref;
    }
  }
  error(value: unknown, execution: Execution, persistent: boolean) {
    const serialized = JSON.stringify(value ?? null);
    if (Buffer.byteLength(serialized) <= 16 * 1024) {
      execution.error = value ?? null;
      return;
    }
    const ref = randomUUID();
    this.put(persistent ? 'code_result' : 'code_read_result', ref, {
      serialized,
      created_at: Date.now(),
    });
    execution.error_ref = ref;
    execution.error = {
      code: isRecord(value) && typeof value.code === 'string' ? value.code : 'execution_error',
      message: 'Подробности ошибки сохранены; прочитайте error_ref через runtime.get_result.',
    };
  }
  readResult(ref: string, offset: number, limit: number) {
    const value = this.get('code_result', ref) ?? this.get('code_read_result', ref);
    if (!isRecord(value) || typeof value.serialized !== 'string')
      throw new Fault('not_found', 'Результат не найден.');
    let text = value.serialized.slice(offset, offset + limit);
    while (Buffer.byteLength(JSON.stringify(text)) > 32 * 1024)
      text = text.slice(0, Math.floor(text.length / 2));
    return {
      ref,
      encoding: 'json',
      text,
      offset,
      next_offset: offset + text.length < value.serialized.length ? offset + text.length : null,
      total_characters: value.serialized.length,
    };
  }
}
