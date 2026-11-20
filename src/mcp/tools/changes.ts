import { z } from 'zod';
import type { ToolContext } from '../tool-context.js';

export function registerChangesTools({ engine, tool }: ToolContext) {
  tool(
    'get_operation',
    'Прочитать результат операции записи и статусы её шагов.',
    { operation_id: z.string().uuid() },
    (args) => engine.getOperation(args.operation_id),
  );
}
