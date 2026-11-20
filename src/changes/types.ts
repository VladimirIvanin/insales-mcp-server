import type { Json } from '../shared/common.js';
import type { Target } from '../shared/schemas.js';
import type { CatalogWrite } from '../features/catalog/service.js';
import type {
  ProductWrite,
  ProductItemWrite,
  ProductImagesBatchWrite,
  ProductDetailsWrite,
} from '../features/products/types.js';
import type { MenuWrite } from '../features/menus/service.js';

export interface ResourceItem {
  target: Target;
  action: 'create' | 'update';
  fields: Json;
  before: Json | null;
  base_revision?: string | undefined;
  validation: { errors: string[]; warnings: string[] };
}

export interface ResourceWrite {
  kind: 'resource';
  id: string;
  store_id: string;

  items: ResourceItem[];
}

export type PreparedWrite =
  | ResourceWrite
  | CatalogWrite
  | ProductWrite
  | ProductItemWrite
  | ProductImagesBatchWrite
  | ProductDetailsWrite
  | MenuWrite;

export interface Operation {
  id: string;
  store_id: string;
  status: string;
  items: Json[];
}
