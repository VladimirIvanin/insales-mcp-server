import { z } from 'zod';
import { idField, storeArgs, collectionFields } from '../../shared/schemas.js';
import type { ToolContext } from '../tool-context.js';

export function registerCatalogTools(context: ToolContext) {
  const { engine, tool } = context;
  tool(
    'change_collection',
    'Создать, изменить или удалить категории каталога. Удаление возможно только для пустой конечной категории; смарт-фильтры не поддерживаются.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      action: z.enum(['create', 'update', 'delete']),
      id: idField().optional(),
      fields: collectionFields.optional(),
      base_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    (a) =>
      engine.runWrite('change_collection', a, async (id) => {
        const prepared = await engine.catalog.prepareCollection(
          a.store_id,
          a.action,
          a.id,
          a.fields,
          a.base_revision,
        );
        return engine.catalog.apply({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'change_collection_membership',
    'Добавить или снять товар с обычной категории каталога. Состав смарт-категории вручную менять нельзя.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      action: z.enum(['add', 'remove']),
      collection_id: idField(),
      product_id: idField(),
    },
    (a) =>
      engine.runWrite('change_collection_membership', a, async (id) => {
        const prepared = await engine.catalog.prepareMembership(
          a.store_id,
          a.action,
          a.collection_id,
          a.product_id,
        );
        return engine.catalog.apply({ ...prepared, id });
      }),
    'write',
    false,
  );
}
