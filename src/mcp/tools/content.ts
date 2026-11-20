import type { ToolContext } from '../tool-context.js';
import { readContent, readContentSchema } from '../../features/content/read-content.js';

export function registerContentTools(context: ToolContext) {
  const { engine, tool } = context;
  tool(
    'read_content',
    'Список или объект: blog, page, article, product, collection, collect, menu (Liquid link_lists) или menu_item. Для get возвращает revision там, где доступно.',
    readContentSchema,
    (a) => readContent(engine, a),
  );
}
