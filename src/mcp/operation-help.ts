const store_id = '<store_id from list_stores>';
const theme_id = 1001;
const id = 2001;
const base_revision = '0'.repeat(64);
const expected_updated_at = '2000-01-01T00:00:00.000000Z';
const operation_id = '11111111-1111-4111-8111-111111111111';

interface Help {
  args: Record<string, unknown>;
  result: unknown;
  workflow: string;
  related: string[];
}

export const operationHelp: Record<string, Help> = {
  list_stores: {
    args: {},
    result: [
      { id: 'configured-example', name: 'Example store', url: 'https://example.insales.ru' },
    ],
    workflow: 'Read the actual store_id first. Credentials are never arguments.',
    related: ['test_store_connection'],
  },
  read_product_card: {
    args: { store_id, id },
    result: {
      data: { id, description: 'Old description', variants: [{ id: 3001, price: '123.0' }] },
      revision: base_revision,
    },
    workflow:
      'Use this revision with update_product_card. For update_product obtain its own revision from read_content(kind=product,mode=get).',
    related: ['update_product_card', 'read_product_item'],
  },
  read_product_item: {
    args: { store_id, product_id: id, kind: 'variant', id: 3001 },
    result: { data: { id: 3001, price: '123.0' }, revision: base_revision },
    workflow: 'Use this item revision for an update/delete of this specific variant or image.',
    related: ['change_product_variant', 'change_product_image'],
  },
  read_content: {
    args: { store_id, kind: 'product', mode: 'get', id },
    result: { data: { id, description: 'Old description' }, revision: base_revision },
    workflow:
      'Read a list to select IDs, then get the selected resource. Pair this revision with update_product; the full-card revision is a different contract.',
    related: ['update_product', 'update_page', 'update_article'],
  },
  update_product: {
    args: {
      store_id,
      id,
      fields: { description: 'New description' },
      base_revision,
    },
    result: { id: operation_id, status: 'applied', items: [{ status: 'applied' }] },
    workflow:
      'Obtain base_revision from read_content(kind=product,mode=get). fields is an object containing actual new values. This call writes immediately.',
    related: ['read_content', 'get_operation'],
  },
  update_product_card: {
    args: { store_id, id, fields: { description: 'New description' }, base_revision },
    result: { id: operation_id, status: 'applied', items: [{ status: 'applied' }] },
    workflow:
      'Obtain base_revision from read_product_card. fields is an object, not an array or a list of field names. This call writes immediately.',
    related: ['read_product_card', 'get_operation'],
  },
  change_product_variant: {
    args: {
      store_id,
      product_id: id,
      id: 3001,
      action: 'update',
      fields: { price: 321 },
      base_revision,
    },
    result: { id: operation_id, status: 'applied', items: [{ status: 'applied' }] },
    workflow:
      'Read the variant through read_product_item(kind=variant). Pass its revision as base_revision.',
    related: ['read_product_item', 'get_operation'],
  },
  get_operation: {
    args: { operation_id },
    result: { id: operation_id, status: 'applied', items: [{ status: 'applied' }] },
    workflow: 'Read the journal after a write or when the outcome is uncertain.',
    related: [],
  },
  get_widget: {
    args: { store_id, theme_id, id },
    result: {
      id,
      widget_type_id: 4001,
      settings: { qa_title: { ru: 'Old title' } },
      updated_at: expected_updated_at,
      edit_context: { copy_required: false },
    },
    workflow:
      'Read the form/type to choose a real setting name. Preserve the exact updated_at for update_widget or make_widget_custom.',
    related: ['get_widget_type', 'update_widget', 'make_widget_custom'],
  },
  update_widget: {
    args: {
      store_id,
      theme_id,
      id,
      parameters: { settings: { qa_title: 'New title' }, expected_updated_at },
    },
    result: {
      status: 'applied',
      result: { id, settings: { qa_title: { ru: 'New title' } }, updated_at: expected_updated_at },
    },
    workflow:
      'This example setting is synthetic. Select a setting from the actual form. Body fields belong inside parameters. Use the original get_widget timestamp, then reread and verify the storefront.',
    related: ['get_widget', 'get_widget_type', 'render_widget'],
  },
  make_widget_custom: {
    args: { store_id, theme_id, id, parameters: { expected_updated_at } },
    result: {
      status: 'applied',
      result: { widget_id: id, widget_type_id: 4002, copied_widget_type: true },
    },
    workflow:
      'Use the widget timestamp. Update the returned widget_type_id for independent code, then verify the original shared type remains unchanged.',
    related: ['get_widget', 'get_widget_type', 'update_widget_type'],
  },
  get_page_structure: {
    args: { store_id, theme_id, parameters: { path: '/', include: 'placements,blocks' } },
    result: {
      path: '/',
      page_kind: 'index',
      widget_lists: [{ id: 5001, handle: 'index-list', widgets: [{ id }] }],
    },
    workflow:
      'Inspect widget_lists and shared_widget_lists. Count actual widget items rather than list positions. Inspect missing compositions through list_widget_list_widgets.',
    related: ['list_widget_list_widgets', 'get_widget'],
  },
};
