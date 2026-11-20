import { z } from 'zod';
import { Fault, isRecord } from '../../shared/common.js';
import { appendQuery } from '../../infrastructure/http/transport.js';
import type { ToolContext } from '../tool-context.js';
import { storeArgs } from '../../shared/schemas.js';
import catalog from '../../features/public-api/catalog.json' with { type: 'json' };
import {
  themeFilesWriteAllowed,
  type McpAccess,
} from '../../infrastructure/insales/write-access.js';

const identifier = z.union([
  z.number().int().safe().positive(),
  z
    .string()
    .regex(/^[a-zA-Z0-9_@+.-]+$/)
    .refine((s) => s !== '.' && s !== '..'),
]);
const operations = z
  .array(
    z.object({
      name: z.string(),
      resource: z.string(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string(),
      variants: z.array(
        z.object({
          title: z.string(),
          query: z.record(z.string()).optional(),
          parameters: z.array(z.array(z.string())).optional(),
          body_fields: z.record(z.unknown()).optional(),
        }),
      ),
    }),
  )
  .parse(catalog);

export const publicApiResources = new Map(operations.map(({ name, resource }) => [name, resource]));

export function registerPublicApi({ tool, engine }: ToolContext, access: McpAccess = 'full') {
  for (const operation of operations) {
    const read = operation.method === 'GET';
    if (!read && access === 'theme_files' && !themeFilesWriteAllowed(operation.path)) continue;
    const params = [...operation.path.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]!);
    const fixed = Object.fromEntries(
      Object.entries(operation.variants[0]?.query ?? {}).filter(
        ([key, value]) =>
          !value.startsWith(':') &&
          operation.variants.every((variant) => variant.query?.[key] === value),
      ),
    );
    const queryDescription = operation.variants.map((variant) => variant.query).filter(Boolean);
    const bodyDescription = operation.variants
      .map((variant) => variant.body_fields)
      .filter(Boolean);
    tool(
      operation.name,
      `${operation.resource}. ${operation.variants.map((v) => v.title).join(' / ')}. ${operation.method} ${operation.path}`,
      {
        ...storeArgs,
        ...Object.fromEntries(params.map((key) => [key, identifier])),
        query: z
          .record(z.unknown())
          .optional()
          .describe(
            JSON.stringify({
              examples: queryDescription,
              parameters: operation.variants.flatMap((v) => v.parameters ?? []),
            }),
          ),
        ...(read
          ? {}
          : {
              body: z.record(z.unknown()).optional().describe(JSON.stringify(bodyDescription)),
              operation_id: z.string().uuid().optional(),
            }),
      },
      (args) => {
        const input: Record<string, unknown> = args;
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries({
          ...fixed,
          ...(isRecord(input.query) ? input.query : {}),
        })) {
          if (key === '_method')
            throw new Fault('validation_failed', 'Параметр _method недоступен.');
          appendQuery(query, key, value);
        }
        const pathname = operation.path.replace(/:([a-zA-Z0-9_]+)/g, (_, key: string) =>
          encodeURIComponent(String(input[key])),
        );
        const path = query.size ? `${pathname}?${query}` : pathname;
        const body = isRecord(input.body) ? input.body : undefined;
        const call = () => engine.api.requestUnknown(args.store_id, operation.method, path, body);
        return read ? call() : engine.runPublicWrite(operation.name, args.store_id, input, call);
      },
      read ? 'read' : 'write',
      read,
    );
  }
}
