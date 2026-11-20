import { z } from 'zod';
import {
  idField,
  storeArgs,
  pageFields,
  articleFields,
  productFields,
} from '../../shared/schemas.js';
import type { ToolContext } from '../tool-context.js';

export function registerResourceChangesTools({ engine, tool }: ToolContext) {
  for (const [kind, fields] of [
    ['page', pageFields],
    ['article', articleFields],
    ['product', productFields],
  ] as const) {
    for (const action of kind === 'product'
      ? (['update'] as const)
      : (['create', 'update'] as const)) {
      const name = `${action}_${kind}`;
      const scope: z.ZodRawShape = kind === 'article' ? { blog_id: idField() } : {};
      tool(
        name,
        action === 'update'
          ? `Изменить ${kind}. Передайте base_revision из read_content.`
          : `Создать ${kind}.`,
        {
          ...storeArgs,
          ...scope,
          ...(action === 'update'
            ? { id: idField(), base_revision: z.string().regex(/^[a-f0-9]{64}$/) }
            : {}),
          fields,
          operation_id: z.string().uuid().optional(),
        },
        (args) =>
          engine.runWrite(name, args, (id) =>
            engine.writeResource(
              [
                {
                  store_id: args.store_id,
                  target: {
                    kind,
                    id: 'id' in args && typeof args.id === 'number' ? args.id : undefined,
                    blog_id:
                      'blog_id' in args && typeof args.blog_id === 'number'
                        ? args.blog_id
                        : undefined,
                  },
                  action,
                  fields: args.fields,
                  base_revision:
                    'base_revision' in args && typeof args.base_revision === 'string'
                      ? args.base_revision
                      : undefined,
                },
              ],
              id,
            ),
          ),
        'write',
        false,
      );
    }
  }
}
