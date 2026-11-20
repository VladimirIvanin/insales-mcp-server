import { z } from 'zod';
import { Fault } from '../../shared/common.js';
import type { OperationRegistry } from '../operations.js';
import type { ToolRegistrar } from '../register-tool.js';
import { publicApiResources } from './public-api.js';

export function registerGroupedTools(
  tool: ToolRegistrar,
  registry: OperationRegistry,
  domain: 'themes' | 'public_api',
  catalog: string,
  read: string,
  write: string,
) {
  const operationName = z.string().min(1).max(200);
  const shape = { operation: operationName, arguments: z.record(z.unknown()).default({}) };
  const get = (name: string) => {
    const operation = registry.operations.get(name);
    if (!operation || operation.domain !== domain)
      throw new Fault('unknown_operation', `Найдите операцию через ${catalog}.`, { name });
    return operation;
  };

  tool(
    catalog,
    `Найти операции группы ${domain} и получить схему аргументов выбранной операции.`,
    {
      operation: operationName.optional(),
      query: z.string().max(500).optional(),
      ...(domain === 'public_api' ? { resource: z.string().max(100).optional() } : {}),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    },
    ({ operation, query, resource, offset, limit }) => {
      if (operation) {
        const { name, description, effect, inputSchema } = get(operation);
        return { name, description, effect, inputSchema };
      }
      const terms = query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const matches = [...registry.operations.values()].filter(
        (item) =>
          item.domain === domain &&
          (!resource ||
            publicApiResources.get(item.name)?.toLowerCase() === resource.toLowerCase()) &&
          terms.every((term) => `${item.name} ${item.description}`.toLowerCase().includes(term)),
      );
      return {
        ...(domain === 'public_api' && !resource && !query
          ? { resources: [...new Set(publicApiResources.values())] }
          : {}),
        total: matches.length,
        next_offset: offset + limit < matches.length ? offset + limit : null,
        operations: matches
          .slice(offset, offset + limit)
          .map(({ name, description, effect }) => ({ name, description, effect })),
      };
    },
  );
  for (const [name, effect] of [
    [read, 'read'],
    [write, 'write'],
  ] as const) {
    tool(
      name,
      `Вызвать операцию ${domain}. Схема arguments доступна через ${catalog}.`,
      shape,
      (args) => {
        const operation = get(args.operation);
        if (operation.effect !== effect)
          throw new Fault(
            'invalid_operation_effect',
            `Используйте ${operation.effect === 'read' ? read : write}.`,
          );
        return operation.invoke(args.arguments);
      },
      effect,
      effect === 'read',
    );
  }
}
