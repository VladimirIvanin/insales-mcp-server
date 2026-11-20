import type { Api } from '../../api.js';
import { ProductCreation } from './creation.js';
import { ProductDetails } from './details.js';
import { ProductItems } from './items.js';
import type { ProductDetailsWrite, ProductImagesBatchWrite, ProductItemWrite } from './types.js';
export type {
  ProductWrite,
  ProductItemWrite,
  ProductImagesBatchWrite,
  ProductDetailsWrite,
} from './types.js';

/** Existing composition API for product operations. */
export class ProductCatalog extends ProductCreation {
  private readonly details: ProductDetails;
  private readonly items: ProductItems;
  constructor(api: Api) {
    super(api);
    this.details = new ProductDetails(api);
    this.items = new ProductItems(api);
  }
  prepareDetails(...args: Parameters<ProductDetails['prepareDetails']>) {
    return this.details.prepareDetails(...args);
  }
  prepareProperties(...args: Parameters<ProductDetails['prepareProperties']>) {
    return this.details.prepareProperties(...args);
  }
  prepareOptionAdd(...args: Parameters<ProductDetails['prepareOptionAdd']>) {
    return this.details.prepareOptionAdd(...args);
  }
  prepareItem(...args: Parameters<ProductItems['prepareItem']>) {
    return this.items.prepareItem(...args);
  }
  prepareImagesBatch(...args: Parameters<ProductItems['prepareImagesBatch']>) {
    return this.items.prepareImagesBatch(...args);
  }
  validateDetails(prepared: ProductDetailsWrite) {
    return this.details.validateDetails(prepared);
  }
  applyDetails(prepared: ProductDetailsWrite) {
    return this.details.applyDetails(prepared);
  }
  readItem(store: string, productId: number, itemKind: 'variant' | 'image', itemId: number) {
    return this.items.readItem(store, productId, itemKind, itemId);
  }
  validateImagesBatch(prepared: ProductImagesBatchWrite) {
    return this.items.validateImagesBatch(prepared);
  }
  applyImagesBatch(prepared: ProductImagesBatchWrite) {
    return this.items.applyImagesBatch(prepared);
  }
  validateItem(prepared: ProductItemWrite) {
    return this.items.validateItem(prepared);
  }
  applyItem(prepared: ProductItemWrite) {
    return this.items.applyItem(prepared);
  }
}
