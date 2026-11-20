import { z } from 'zod';
import { Fault } from '../../shared/common.js';
import { idField, pagination, storeArgs } from '../../shared/schemas.js';
import type { ChangeCoordinator } from '../../changes/coordinator.js';

export const readContentSchema = {
  ...storeArgs,
  kind: z.enum([
    'blog',
    'page',
    'article',
    'product',
    'collection',
    'collect',
    'menu',
    'menu_item',
  ]),
  mode: z.enum(['list', 'get']),
  id: idField().optional(),
  blog_id: idField().optional(),
  product_id: idField().optional(),
  collection_id: idField().optional(),
  menu_id: idField().optional(),
  parent_id: idField().optional(),
  ...pagination,
};
export type ReadContentArgs = z.output<z.ZodObject<typeof readContentSchema>>;

export async function readContent(engine: ChangeCoordinator, a: ReadContentArgs) {
  if ((a.mode === 'list' && a.id !== undefined) || (a.mode === 'get' && a.id === undefined))
    throw new Fault('validation_failed', 'Для get нужен id; для list id не передавайте.');
  if (
    (a.blog_id !== undefined && a.kind !== 'article') ||
    (a.kind === 'article' && a.blog_id === undefined)
  )
    throw new Fault('validation_failed', 'blog_id нужен только для article.');
  if (a.parent_id !== undefined && (a.kind !== 'collection' || a.mode !== 'list'))
    throw new Fault('validation_failed', 'parent_id доступен только для списка collection.');
  if (
    (a.product_id !== undefined || a.collection_id !== undefined) &&
    (a.kind !== 'collect' || a.mode !== 'list')
  )
    throw new Fault(
      'validation_failed',
      'product_id/collection_id доступны только для списка collect.',
    );
  if ((a.kind === 'menu_item') !== (a.menu_id !== undefined))
    throw new Fault(
      'validation_failed',
      'Для menu_item нужен menu_id; для других видов он не нужен.',
    );
  if (a.kind === 'menu' || a.kind === 'menu_item')
    return a.mode === 'list'
      ? engine.menus.list(a.store_id, a.kind, a.menu_id, a.page, a.per_page)
      : engine.menus.read(a.store_id, a.kind, a.id!, a.menu_id);
  if (a.kind === 'blog') {
    if (a.mode !== 'list')
      throw new Fault('unsupported_capability', 'Для blog доступен только список.');
    return engine.client(a.store_id).blogs.list({ page: a.page, per_page: a.per_page });
  }
  if (a.kind === 'collection')
    return a.mode === 'list'
      ? engine.catalog.listCollections(a.store_id, a.page, a.per_page, a.parent_id)
      : engine.catalog.readCollection(a.store_id, a.id!);
  if (a.kind === 'collect')
    return a.mode === 'list'
      ? engine.catalog.listCollects(a.store_id, a.page, a.per_page, a.product_id, a.collection_id)
      : engine.catalog.readCollect(a.store_id, a.id!);
  return a.mode === 'list'
    ? engine.list(a.store_id, { kind: a.kind, blog_id: a.blog_id }, a.page, a.per_page)
    : engine.read(a.store_id, { kind: a.kind, id: a.id, blog_id: a.blog_id });
}
