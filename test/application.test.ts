import { callOperation } from './code-mode-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/app/application.js';
import { createMcpServer } from '../src/mcp/server.js';

test('two protocol servers share application services and close independently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-mcp-app-'));
  const application = createApplication(undefined, {
    dataDirectory: directory,
    autoCleanup: false,
  });
  const first = createMcpServer(application);
  const second = createMcpServer(application);
  const clients = [
    new Client({ name: 'client-0', version: '1' }),
    new Client({ name: 'client-1', version: '1' }),
  ] as const;
  const pairs = [
    InMemoryTransport.createLinkedPair(),
    InMemoryTransport.createLinkedPair(),
  ] as const;
  try {
    await first.connect(pairs[0][1]);
    await second.connect(pairs[1][1]);
    await clients[0].connect(pairs[0][0]);
    await clients[1].connect(pairs[1][0]);
    assert.deepEqual((await clients[0].listTools()).tools, (await clients[1].listTools()).tools);
    await clients[0].close();
    await first.close();
    const result = await callOperation(clients[1], { name: 'list_stores', arguments: {} });
    assert.deepEqual(result.content, [{ type: 'text', text: '[]' }]);
  } finally {
    await clients[1].close();
    await second.close();
    await application.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('application disposal waits for in-flight work before closing shared storage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-mcp-drain-'));
  const application = createApplication(undefined, {
    dataDirectory: directory,
    autoCleanup: false,
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const operation = application.calls.run(async () => {
      await gate;
      return application.engine.api.state.stores();
    });
    const disposal = application.dispose();
    assert.equal(await Promise.race([disposal.then(() => true), Promise.resolve(false)]), false);
    finish();
    assert.deepEqual(await operation, []);
    await disposal;
    await assert.rejects(
      application.calls.run(async () => []),
      /stopping/,
    );
  } finally {
    finish();
    await application.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
