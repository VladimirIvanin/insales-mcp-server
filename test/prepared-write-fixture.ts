import type { Api } from '../src/api.js';
import { ChangeCoordinator } from '../src/changes/coordinator.js';
import type { PreparedWrite } from '../src/changes/types.js';
import { prepareResourceWrite } from '../src/features/content/prepare-write.js';

export function createPreparedWriteFixture(api: Api) {
  const engine = new ChangeCoordinator(api);
  const pending = new Map<string, PreparedWrite>();
  function stage<T extends PreparedWrite>(prepared: T) {
    pending.set(prepared.id, prepared);
    return { ...prepared, change_id: prepared.id };
  }
  function get(id: string) {
    const prepared = pending.get(id);
    if (!prepared) throw new Error('Missing prepared write');
    return prepared;
  }
  const { catalog, menus, products } = engine;
  return Object.assign(engine, {
    prepared: get,
    async propose(inputs: Parameters<typeof prepareResourceWrite>[1]) {
      return stage(await prepareResourceWrite(engine, inputs));
    },
    async apply(id: string) {
      const prepared = get(id);
      switch (prepared.kind) {
        case 'resource':
          return engine.applyResource(prepared);
        case 'product_create':
          return products.apply(prepared);
        case 'product_item':
          return products.applyItem(prepared);
        case 'product_images_batch':
          return products.applyImagesBatch(prepared);
        case 'product_details':
          return products.applyDetails(prepared);
        case 'menu_change':
          return menus.apply(prepared);
        case 'collection':
        case 'membership':
          return catalog.apply(prepared);
      }
    },
    async validate(id: string) {
      const prepared = get(id);
      if (prepared.kind !== 'product_images_batch') throw new Error('Expected image batch');
      return products.validateImagesBatch(prepared);
    },
    catalog: Object.assign(catalog, {
      async proposeCollection(...args: Parameters<typeof catalog.prepareCollection>) {
        return stage(await catalog.prepareCollection(...args));
      },
      async proposeMembership(...args: Parameters<typeof catalog.prepareMembership>) {
        return stage(await catalog.prepareMembership(...args));
      },
    }),
    menus: Object.assign(menus, {
      async propose(...args: Parameters<typeof menus.prepare>) {
        return stage(await menus.prepare(...args));
      },
    }),
    products: Object.assign(products, {
      async proposeCreate(...args: Parameters<typeof products.prepareCreate>) {
        return stage(await products.prepareCreate(...args));
      },
      async proposeDetails(...args: Parameters<typeof products.prepareDetails>) {
        return stage(await products.prepareDetails(...args));
      },
      async proposeImagesBatch(...args: Parameters<typeof products.prepareImagesBatch>) {
        return stage(await products.prepareImagesBatch(...args));
      },
      async proposeItem(...args: Parameters<typeof products.prepareItem>) {
        return stage(await products.prepareItem(...args));
      },
      async proposeOptionAdd(...args: Parameters<typeof products.prepareOptionAdd>) {
        return stage(await products.prepareOptionAdd(...args));
      },
      async proposeProperties(...args: Parameters<typeof products.prepareProperties>) {
        return stage(await products.prepareProperties(...args));
      },
    }),
  });
}
