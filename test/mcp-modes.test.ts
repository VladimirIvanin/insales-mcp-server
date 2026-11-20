import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpOptionsFromEnvironment } from '../src/app/config.js';
import { ChangeCoordinator } from '../src/changes/coordinator.js';
import { Api } from '../src/api.js';
import { DirectThemeResources } from '../src/features/themes/direct.js';
import { Knowledge } from '../src/infrastructure/knowledge/index.js';
import { State } from '../src/infrastructure/persistence/state.js';
import { createMcpServer, createOperations } from '../src/mcp/server.js';

test('MCP options are independent of store credentials', () => {
  assert.deepEqual(mcpOptionsFromEnvironment({}), {
    mode: 'code',
    fullApi: false,
    access: 'full',
    themeId: undefined,
  });
  assert.deepEqual(
    mcpOptionsFromEnvironment({
      INSALES_MCP_MODE: 'tools',
      INSALES_MCP_FULL_API: '1',
      INSALES_MCP_ACCESS: 'theme_files',
      INSALES_MCP_THEME_ID: '9',
    }),
    { mode: 'tools', fullApi: true, access: 'theme_files', themeId: 9 },
  );
  for (const [key, value] of [
    ['INSALES_MCP_MODE', 'other'],
    ['INSALES_MCP_FULL_API', 'yes'],
    ['INSALES_MCP_ACCESS', 'shop'],
    ['INSALES_MCP_THEME_ID', '1e3'],
  ] as const)
    assert.throws(() => mcpOptionsFromEnvironment({ [key]: value }), { code: 'invalid_config' });
});

test('both MCP modes share operations with optional public API discovery', async (t) => {
  const knowledge = new Knowledge();
  t.after(() => knowledge.close());
  const engine = {} as ChangeCoordinator;
  for (const mode of ['code', 'tools'] as const) {
    for (const fullApi of [false, true]) {
      const services = {
        engine,
        knowledge,
        mcpOptions: { mode, fullApi, access: 'full' as const, themeId: undefined },
      };
      const server = createMcpServer(services);
      const client = new Client({ name: 'mode-test', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        if (mode === 'code') assert.deepEqual(names, ['execute_read', 'execute_write']);
        else {
          assert.ok(
            ['theme_api', 'theme_read', 'theme_write', 'update_page', 'get_operation'].every(
              (name) => names.includes(name),
            ),
          );
          assert.equal(names.filter((name) => name.startsWith('api_')).length, fullApi ? 3 : 0);
          if (fullApi) {
            const response = await client.callTool({
              name: 'api_catalog',
              arguments: { resource: 'Product' },
            });
            assert.ok(Array.isArray(response.content));
            const item = response.content[0] as { text: string };
            const result = JSON.parse(item.text);
            assert.ok(result.total > 0 && result.total < 293);
            assert.ok(
              result.operations.every((operation: { description: string }) =>
                operation.description.startsWith('Product.'),
              ),
            );
          }
          assert.ok(!names.includes('apply_change'));
        }
        const operations = createOperations(services).operations;
        assert.equal(
          [...operations.values()].filter((item) => item.domain === 'public_api').length,
          fullApi ? 293 : 0,
        );
        assert.ok(!operations.has('propose_page_change'));
      } finally {
        await client.close();
        await server.close();
      }
    }
  }
});

test('theme restrictions and published operation paths are enforced before transport', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-mcp-modes-'));
  const state = new State(directory, {
    id: 'one',
    name: 'Example',
    url: 'https://example.insales.ru',
  });
  state.rateSlot = () => 0;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api = new Api(
    state,
    { key: 'test', password: 'test' },
    {
      async request(_store, _credentials, method, path, body) {
        calls.push({ method, path, body });
        return null;
      },
    },
    undefined,
    9,
  );
  const knowledge = new Knowledge();
  t.after(() => {
    state.close();
    knowledge.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await api.request('one', 'GET', '/admin/theme_editor/v1/themes/10/widgets/2.json');
  await api.request('one', 'POST', '/admin/theme_editor/v1/themes/10/widgets/2/render.json');
  await api.request('one', 'PATCH', '/admin/theme_editor/v1/themes/9/widgets/2.json');
  await api.request('one', 'PATCH', '/admin/theme_editor/v1/block_lists/2.json');
  const before = calls.length;
  for (const [method, path] of [
    ['PATCH', '/admin/theme_editor/v1/themes/10/widgets/2.json'],
    ['POST', '/admin/theme_editor/v1/themes/9/publish.json'],
    ['POST', '/admin/theme_editor/v1/themes/9/duplicate.json'],
    ['PUT', '/admin/themes/10/assets/2.json'],
  ] as const)
    await assert.rejects(api.request('one', method, path), { code: 'theme_write_restricted' });
  const oldOperation = randomUUID();
  state.put('operation', oldOperation, {
    id: oldOperation,
    store_id: 'one',
    method_id: 'target-themes-duplicate',
    method: 'POST',
    path: '/admin/theme_editor/v1/themes/10/duplicate.json',
    body: {},
    items: [],
    fingerprint: 'saved',
    idempotency_key: oldOperation,
    expires_at: Date.now() + 60_000,
    status: 'execution_unknown',
  });
  await assert.rejects(new DirectThemeResources(api).retry(oldOperation), {
    code: 'theme_write_restricted',
  });
  assert.equal(calls.length, before);

  const registry = createOperations({
    engine: new ChangeCoordinator(api),
    knowledge,
    mcpOptions: { mode: 'code', fullApi: true, access: 'full', themeId: 9 },
  });
  const get = registry.get('api_get_collects');
  await get.invoke({ store_id: 'one', query: { collection_id: 2 } });
  assert.equal(calls.at(-1)?.path, '/admin/collects.json?collection_id=2');
  const write = registry.get('api_put_products_product_id');
  const args = {
    store_id: 'one',
    operation_id: randomUUID(),
    product_id: 14,
    body: { product: { title: 'Example' } },
  };
  const first = await write.invoke(args);
  assert.deepEqual(await write.invoke(args), first);
  assert.equal(calls.length, before + 2);
  assert.deepEqual(calls.at(-1), {
    method: 'PUT',
    path: '/admin/products/14.json',
    body: args.body,
  });
  await assert.rejects(write.invoke({ ...args, product_id: '../themes' }), {
    code: 'validation_failed',
  });
  await assert.rejects(write.invoke({ ...args, product_id: 15 }), {
    code: 'idempotency_key_reused',
  });
});

test('theme_files allows theme and file writes and blocks the rest', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-mcp-access-'));
  const state = new State(directory, {
    id: 'one',
    name: 'Example',
    url: 'https://example.insales.ru',
  });
  state.rateSlot = () => 0;
  const calls: string[] = [];
  const api = new Api(
    state,
    { key: 'test', password: 'test' },
    {
      async request(_store, _credentials, method, path) {
        calls.push(`${method} ${path}`);
        return null;
      },
    },
    undefined,
    9,
    'theme_files',
  );
  const knowledge = new Knowledge();
  t.after(() => {
    state.close();
    knowledge.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await api.request('one', 'PATCH', '/admin/theme_editor/v1/themes/9/widgets/2.json', {});
  await api.request('one', 'PUT', '/admin/themes/9/assets/2.json', {});
  await api.request('one', 'POST', '/admin/files.json', {});
  await api.request('one', 'GET', '/admin/products/14.json');
  assert.deepEqual(calls, [
    'PATCH /admin/theme_editor/v1/themes/9/widgets/2.json',
    'PUT /admin/themes/9/assets/2.json',
    'POST /admin/files.json',
    'GET /admin/products/14.json',
  ]);
  const before = calls.length;
  for (const [method, path] of [
    ['PUT', '/admin/products/14.json'],
    ['POST', '/admin/pages.json'],
    ['PATCH', '/admin/menus/1.json'],
    ['PUT', '/admin/collections/2.json'],
    ['PUT', '/admin/files/../products/14.json'],
    ['POST', '/admin/files/%2e%2e/products/14.json'],
  ] as const)
    await assert.rejects(api.request('one', method, path, {}), { code: 'write_restricted' });
  await assert.rejects(
    api.request('one', 'PATCH', '/admin/theme_editor/v1/themes/10/widgets/2.json', {}),
    { code: 'theme_write_restricted' },
  );
  assert.equal(calls.length, before);

  const services = {
    engine: new ChangeCoordinator(api),
    knowledge,
    mcpOptions: {
      mode: 'tools' as const,
      fullApi: true,
      access: 'theme_files' as const,
      themeId: 9,
    },
  };
  const registry = createOperations(services);
  const operations = registry.operations;
  assert.equal(operations.has('api_put_products_product_id'), false);
  assert.equal(operations.has('api_post_files'), true);
  assert.equal(operations.has('api_get_products'), true);
  assert.equal(operations.has('update_product'), false);
  assert.equal(operations.has('create_product'), false);
  assert.equal(operations.has('change_menu'), false);
  assert.equal(operations.has('change_collection'), false);
  assert.equal(operations.has('update_page'), false);
  assert.equal(operations.has('update_widget'), true);
  assert.equal(operations.has('read_content'), true);
  assert.throws(() => registry.get('api_put_products_product_id'), {
    code: 'unknown_operation',
  });
  const denied = await services.engine.runPublicWrite(
    'api_put_products_product_id',
    'one',
    { operation_id: randomUUID() },
    () => api.request('one', 'PUT', '/admin/products/14.json', { product: { title: 'Example' } }),
  );
  assert.equal(denied.status, 'failed');
  assert.equal(calls.length, before);

  const server = createMcpServer(services);
  const client = new Client({ name: 'access-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes('update_page'), false);
    assert.equal(names.includes('create_product'), false);
    assert.ok(names.includes('theme_write'));
    assert.ok(names.includes('read_content'));
    assert.match(client.getInstructions() ?? '', /theme_files/);
  } finally {
    await client.close();
    await server.close();
  }
});
