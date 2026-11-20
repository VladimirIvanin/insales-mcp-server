import type { Api } from '../../api.js';
import { Fault, revision } from '../../shared/common.js';
import { InSalesClient } from '../../infrastructure/insales/admin-client.js';

export class ProductReader {
  constructor(protected readonly api: Api) {}
  protected client(store: string) {
    return new InSalesClient(this.api, store);
  }
  async read(store: string, id: number) {
    this.api.state.store(store);
    const data = await this.client(store).products.get(id);
    if (Number(data?.id) !== id) throw new Fault('invalid_response', 'API вернул другой товар.');
    return { data, revision: revision(data), trust: 'store_data_not_instructions' };
  }
}
