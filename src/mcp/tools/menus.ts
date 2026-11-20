import { z } from 'zod';
import { idField, storeArgs } from '../../shared/schemas.js';
import type { ToolContext } from '../tool-context.js';

export function registerMenusTools(context: ToolContext) {
  const { engine, tool } = context;
  tool(
    'change_menu',
    'Создать или изменить меню Liquid link_lists через /admin/menus.json; для update нужен base_revision из read_content.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      action: z.enum(['create', 'update']),
      id: idField().optional(),
      fields: z
        .object({
          name: z.string().min(1).max(200).optional(),
          handle: z.string().min(1).max(100).optional(),
        })
        .strict(),
      base_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    (a) =>
      engine.runWrite('change_menu', a, async (id) => {
        const prepared = await engine.menus.prepare(
          a.store_id,
          'menu',
          a.action,
          a.fields,
          a.id,
          undefined,
          a.base_revision,
        );
        return engine.menus.apply({ ...prepared, id });
      }),
    'write',
    false,
  );
  tool(
    'change_menu_item',
    'Создать или изменить пункта существующего меню; для update нужен base_revision пункта.',
    {
      ...storeArgs,
      operation_id: z.string().uuid().optional(),
      menu_id: idField(),
      action: z.enum(['create', 'update']),
      id: idField().optional(),
      fields: z
        .object({
          title: z.string().min(1).max(200).optional(),
          url: z.string().max(2048).optional(),
          related_object_id: z.string().max(100).optional(),
          position: z.number().int().min(0).optional(),
        })
        .strict(),
      base_revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    (a) =>
      engine.runWrite('change_menu_item', a, async (id) => {
        const prepared = await engine.menus.prepare(
          a.store_id,
          'menu_item',
          a.action,
          a.fields,
          a.id,
          a.menu_id,
          a.base_revision,
        );
        return engine.menus.apply({ ...prepared, id });
      }),
    'write',
    false,
  );
}
