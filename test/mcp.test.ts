import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { Knowledge } from '../src/infrastructure/knowledge/index.js';
import type { ChangeCoordinator } from '../src/changes/coordinator.js';

test('MCP exposes exactly two tools and discovers all operations inside Code Mode', async () => {
  const knowledge = new Knowledge();
  const server = createMcpServer({ engine: {} as ChangeCoordinator, knowledge });
  const client = new Client({ name: 'code-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['execute_read', 'execute_write'],
    );
    assert.equal(tools[0]!.annotations!.readOnlyHint, true);
    assert.equal(tools[1]!.annotations!.destructiveHint, true);
    assert.equal(tools[1]!.annotations!.idempotentHint, false);
    const result = await client.callTool({
      name: 'execute_read',
      arguments: {
        code: 'const map = await catalog.search({}); const methods = await catalog.describe({names:["get_widget_standards"]}); const standards = await insales.get_widget_standards({scenario:"edit_widget"}); return {map,methods,standards};',
      },
    });
    assert.notEqual(result.isError, true);
    const execution = JSON.parse((result.content as any)[0].text);
    assert.equal(execution.result.map.total, 123);
    assert.equal(execution.result.methods[0].name, 'get_widget_standards');
    const products = await client.callTool({
      name: 'execute_read',
      arguments: { code: 'return await catalog.search({query:"товары product"});' },
    });
    assert.ok(
      JSON.parse((products.content as any)[0].text).result.methods.some(
        (method: any) => method.name === 'read_content',
      ),
    );

    const forbidden = await client.callTool({
      name: 'execute_read',
      arguments: { code: 'return await insales.publish_theme({});' },
    });
    assert.equal(forbidden.isError, true);
    assert.equal((await client.callTool({ name: 'list_stores', arguments: {} })).isError, true);
  } finally {
    await client.close();
    await server.close();
    knowledge.close();
  }
});
