import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, createOperations } from '../src/mcp/server.js';
import { Knowledge } from '../src/infrastructure/knowledge/index.js';
import { ROOT } from '../src/shared/common.js';
import type { ChangeCoordinator } from '../src/changes/coordinator.js';

function assertToolReferences(
  body: string,
  source: string,
  registered: Map<string, Set<string>>,
): void {
  // A response field with a tool-like name is documented alongside the tools.
  const nonToolIdentifiers = new Set([
    'preview_local_path',
    'preview_url',
    'read_only_generation',
    'search_url',
    'list_item_id',
    'list_items',
    'get_execution',
    'get_result',
  ]);
  const toolNames =
    /\b(?:search|list|test|read|get|audit|propose|preview|validate|apply)_[a-z0-9_]+\b/g;
  for (const match of body.matchAll(toolNames))
    if (!nonToolIdentifiers.has(match[0]))
      assert.ok(registered.has(match[0]), `${source}: отсутствует MCP tool ${match[0]}`);

  const calls =
    /\b((?:search|list|test|read|get|audit|propose|preview|validate|apply)_[a-z0-9_]+)\(([^()]*)\)/g;
  for (const match of body.matchAll(calls)) {
    const fields = registered.get(match[1]!);
    if (!fields) continue;
    for (const part of match[2]!.split(',')) {
      const argument = /^\s*([a-z][a-z0-9_]*)(?:\s*=|\s*$)/.exec(part);
      if (argument)
        assert.ok(
          fields.has(argument[1]!),
          `${source}: у MCP tool ${match[1]} нет параметра ${argument[1]}`,
        );
    }
  }
}

test('the complete MCP discovery contract remains stable', async () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/mcp-contract.json'), 'utf8'));
  const knowledge = new Knowledge();
  // Tool handlers are not invoked during discovery, so no store or database is needed.
  const server = createMcpServer({ engine: {} as ChangeCoordinator, knowledge });
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const actual = {
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    };
    const publicBaseline = JSON.parse(
      readFileSync(join(ROOT, 'test/fixtures/code-mode-contract.json'), 'utf8'),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), publicBaseline);
    const operations = [
      ...createOperations({ engine: {} as ChangeCoordinator, knowledge }).operations.values(),
    ];
    assert.deepEqual(
      operations.map((o) => ({
        name: o.name,
        description: o.description,
        inputSchema: o.inputSchema,
        annotations: o.annotations,
        execution: { taskSupport: 'forbidden' },
      })),
      baseline.tools,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(actual)) <
        Buffer.byteLength(JSON.stringify(baseline)) * 0.05,
    );
    const registered = new Map(
      operations.map((tool) => [
        tool.name,
        new Set(Object.keys((tool.inputSchema.properties as object | undefined) ?? {})),
      ]),
    );
    const guideRoot = join(ROOT, 'knowledge/widget-development');
    const guides = [
      join(ROOT, 'README.md'),
      ...readdirSync(join(ROOT, 'knowledge'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(ROOT, 'knowledge', name)),
      ...readdirSync(guideRoot)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(guideRoot, name)),
    ];
    assertToolReferences(actual.instructions ?? '', 'MCP instructions', registered);
    for (const tool of actual.tools)
      assertToolReferences(tool.description ?? '', `MCP description ${tool.name}`, registered);
    for (const file of guides) assertToolReferences(readFileSync(file, 'utf8'), file, registered);
    assert.throws(
      () => assertToolReferences('`read_theme_typo`', 'fixture', registered),
      /отсутствует MCP tool read_theme_typo/,
    );
    assert.throws(
      () => assertToolReferences('`get_widget(fake_parameter=1)`', 'fixture', registered),
      /у MCP tool get_widget нет параметра fake_parameter/,
    );
  } finally {
    await client.close();
    await server.close();
    knowledge.close();
  }
});
