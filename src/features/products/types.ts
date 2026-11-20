import type { Json } from '../../shared/common.js';
import type { LocalFile } from '../../infrastructure/uploads/image.js';
import { productCreateInput } from '../../shared/schemas.js';

export type ProductPlan = ReturnType<typeof productCreateInput.parse>;

export interface ProductWrite {
  kind: 'product_create';
  id: string;
  store_id: string;

  plan: ProductPlan;
  local_files: Record<string, LocalFile>;
}

export interface ProductItemWrite {
  kind: 'product_item';
  id: string;
  store_id: string;

  product_id: number;
  item_kind: 'variant' | 'image';
  item_id?: number | undefined;
  action: 'create' | 'update' | 'delete';
  fields: Json;
  base_revision?: string | undefined;
  local_file?: LocalFile | undefined;
}

export interface ProductImagesBatchWrite {
  kind: 'product_images_batch';
  id: string;
  store_id: string;

  items: ProductItemWrite[];
}

export interface ProductDetailsWrite {
  kind: 'product_details';
  id: string;
  store_id: string;

  product_id: number;
  fields: Json;
  base_revision: string;
  expected_properties?: { title: string; value: string }[];
  expected_option_add?: { title: string; value: string; existing_ids: number[] };
}

export interface Step {
  kind: string;
  status: string;
  index?: number;
  result_id?: number | undefined;
  error?: Json | undefined;
}

export interface Operation {
  id: string;
  store_id: string;
  status: string;
  product_id?: number | undefined;
  first_variant_id?: number | undefined;
  items: Step[];
}
