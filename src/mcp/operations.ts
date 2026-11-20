import {
  objectFromShape,
  safeParseAsync,
  getParseErrorMessage,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { z } from 'zod';
import { Fault, isRecord } from '../shared/common.js';
import { operationHelp } from './operation-help.js';
import type { ToolRegistrar } from './register-tool.js';

export type Effect = 'read' | 'draft' | 'write';
export interface Operation {
  name: string;
  domain: string;
  description: string;
  inputSchema: Record<string, unknown>;
  register(tool: ToolRegistrar): void;
  effect: Effect;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  validate(args: unknown): Promise<unknown>;
  invoke(args: unknown): Promise<unknown>;
}

const aliases: Record<string, string> = {
  read: 'get',
  чтение: 'get read',
  изменить: 'update',
  получить: 'get',
  настройка: 'settings',
  виджет: 'widget',
  виджеты: 'widget',
  блок: 'block',
  блоки: 'block',
  тема: 'theme',
  темы: 'theme',
  настройки: 'settings',
  товар: 'product',
  товары: 'product',
  страница: 'page',
  страницы: 'page',
  категория: 'collection',
  категории: 'collection',
  меню: 'menu',
  статья: 'article',
  статьи: 'article',
  файл: 'file',
  файлы: 'file',
  код: 'source code',
  копия: 'copy duplicate',
  история: 'history',
  справка: 'knowledge standards',
};

export class OperationRegistry {
  readonly operations = new Map<string, Operation>();
  domain = 'other';

  readonly tool: ToolRegistrar = <Shape extends ZodRawShapeCompat>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: ShapeOutput<Shape>) => unknown,
    effect: Effect = 'read',
    idempotent = effect !== 'draft',
  ) => {
    if (this.operations.has(name)) throw new Error(`Duplicate operation ${name}`);
    const schema = objectFromShape(shape);
    const inputSchema = toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' });
    const parse = async (args: unknown) => {
      const parsed = await safeParseAsync(schema, args);
      if (!parsed.success)
        throw new Fault('validation_failed', getParseErrorMessage(parsed.error), {
          name,
          inputSchema,
          usage: `catalog.describe({names:["${name}"]})`,
          ...(operationHelp[name]
            ? {
                arguments_example: operationHelp[name].args,
                workflow: operationHelp[name].workflow,
              }
            : {}),
        });
      return parsed.data as ShapeOutput<Shape>;
    };
    this.operations.set(name, {
      name,
      description,
      domain: this.domain,
      effect,
      inputSchema,
      annotations: {
        readOnlyHint: effect === 'read',
        destructiveHint: effect === 'write',
        idempotentHint: idempotent,
        openWorldHint: !(name.includes('knowledge') || name === 'get_widget_standards'),
      },
      register: (tool) => tool(name, description, shape, handler, effect, idempotent),
      validate: parse,
      async invoke(args) {
        return handler(await parse(args));
      },
    });
  };

  search(input: unknown) {
    const { query, domain, limit } = z
      .object({
        query: z.string().max(500).default(''),
        domain: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .strict()
      .parse(input);
    const operations = [...this.operations.values()].filter((o) => !domain || o.domain === domain);
    if (!query.trim())
      return {
        domains: [...new Set(operations.map((o) => o.domain))].map((name) => ({
          name,
          count: operations.filter((o) => o.domain === name).length,
        })),
        ...(domain
          ? {
              methods: operations.map((o) => ({
                name: o.name,
                description: o.description,
                effect: o.effect,
              })),
            }
          : {}),
        total: operations.length,
      };
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = [...new Set(tokens.flatMap((t) => [t, ...(aliases[t]?.split(' ') ?? [])]))];
    const exactNames = new Set(query.toLowerCase().match(/[a-z][a-z0-9_]+/g) ?? []);
    const phrase = tokens.join('_');
    const singular = (word: string) =>
      word.endsWith('ies')
        ? word.slice(0, -3) + 'y'
        : word.endsWith('s')
          ? word.slice(0, -1)
          : word;
    const matches = operations
      .map((o) => {
        const parts = o.name.split('_').map(singular);
        const properties = isRecord(o.inputSchema.properties) ? o.inputSchema.properties : {};
        const selectors = ['kind', 'mode'].flatMap((key) => {
          const field = properties[key];
          return isRecord(field) && Array.isArray(field.enum)
            ? field.enum.filter((value): value is string => typeof value === 'string').map(singular)
            : [];
        });
        const body = `${o.description} ${o.domain}`.toLowerCase();
        const score =
          terms.reduce(
            (n, t) =>
              n +
              (parts.includes(singular(t)) || selectors.includes(singular(t))
                ? 8
                : body.includes(t)
                  ? 1
                  : 0),
            0,
          ) + (exactNames.has(o.name) ? 1000 : phrase.includes(o.name) ? 100 : 0);
        return { operation: o, score };
      })
      .filter((o) => o.score > 0)
      .sort((a, b) => b.score - a.score || a.operation.name.length - b.operation.name.length);
    return {
      total: matches.length,
      methods: matches.slice(0, limit).map(({ operation: o }) => ({
        name: o.name,
        domain: o.domain,
        description: o.description,
        effect: o.effect,
        describe: { names: [o.name] },
      })),
    };
  }

  describe(input: unknown) {
    const { names } = z
      .object({ names: z.array(z.string()).min(1).max(20) })
      .strict()
      .parse(input);
    return names.map((name) => {
      const o = this.get(name);
      const help = operationHelp[name];
      return {
        name: o.name,
        domain: o.domain,
        description: o.description,
        effect: o.effect,
        inputSchema: o.inputSchema,
        annotations: o.annotations,
        signature: `insales.${o.name}(args): Promise<unknown>`,
        example: help
          ? `return await insales.${o.name}(${JSON.stringify(help.args)});`
          : `return await insales.${o.name}(/* supply an object matching inputSchema */);`,
        ...(help
          ? {
              arguments_example: help.args,
              result_example: help.result,
              result_example_is_partial: true,
              workflow: help.workflow,
              related: help.related,
              example_notice:
                'Synthetic IDs, revisions, timestamps and setting names: replace them with actual values obtained by reading the selected resource. Examples are documentation, not authorization.',
            }
          : {}),
      };
    });
  }

  get(name: string) {
    const operation = this.operations.get(name);
    if (!operation)
      throw new Fault(
        'unknown_operation',
        'Метод не найден. Используйте catalog.search({query: name}) и catalog.describe({names:[name]}).',
        { name },
      );
    return operation;
  }
}
