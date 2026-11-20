import { z } from 'zod';
import { Fault } from '../../shared/common.js';
import type { Operation } from '../../changes/types.js';

const operationSchema = z
  .object({
    id: z.string().uuid(),
    store_id: z.string().min(1),
    status: z.string(),
    items: z.array(z.object({ status: z.string() }).passthrough()),
  })
  .passthrough();

function decode<T>(value: unknown, schema: z.ZodTypeAny, label: string): T {
  if (!schema.safeParse(value).success) {
    throw new Fault('invalid_response', `Некорректный сохранённый ${label}.`);
  }
  // Return the original JSON. Zod's parsed result may strip unknown fields or
  // apply defaults, changing a persisted revision or a pending operation.
  return value as T;
}

export function decodeOperation<T = Operation>(value: unknown): T {
  return decode(value, operationSchema, 'результат операции');
}
