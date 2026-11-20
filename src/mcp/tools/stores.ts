import { storeArgs } from '../../shared/schemas.js';
import type { ToolContext } from '../tool-context.js';

export function registerStoresTools(context: ToolContext) {
  const { engine, tool } = context;
  tool('list_stores', 'Список подключённых магазинов без API-реквизитов.', {}, () =>
    engine.api.state.stores(),
  );
  tool('test_store_connection', 'Проверить доступ чтением страниц.', storeArgs, async (a) => {
    await engine.client(a.store_id).pages.list({ per_page: 1 });
    return { connected: true };
  });
}
