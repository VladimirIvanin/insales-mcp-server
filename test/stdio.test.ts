import { callOperation } from './code-mode-client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/shared/common.js';

test('stdio server starts outside the repository and serves the existing tool catalog', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-mcp-stdio-'));
  const client = new Client({ name: 'cwd-check', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin/insales-mcp.mjs')],
    cwd: directory,
    env: {
      ...getDefaultEnvironment(),
      INSALES_MCP_DATA_DIR: join(directory, 'data'),
      INSALES_MCP_AUTO_CLEANUP: '0',
      INSALES_MCP_API_ERROR_LOG: '0',
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'execute_read'));
    const result = await callOperation(client, { name: 'list_stores', arguments: {} });
    assert.deepEqual(result.content, [{ type: 'text', text: '[]' }]);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI rejects HTTP transport and port arguments on stderr', () => {
  for (const args of [['--transport=http'], ['--port=3000']]) {
    const child = spawnSync(process.execPath, [join(ROOT, 'bin/insales-mcp.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /invalid_config/);
  }
});

test('stdio honors tool mode and the optional public API at startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'insales-mcp-stdio-modes-'));
  try {
    for (const mode of ['code', 'tools']) {
      for (const fullApi of ['false', 'true']) {
        const client = new Client({ name: 'stdio-modes', version: '1' });
        try {
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [join(ROOT, 'bin/insales-mcp.mjs'), '--transport=stdio'],
              cwd: directory,
              env: {
                ...getDefaultEnvironment(),
                INSALES_MCP_DATA_DIR: join(directory, 'data'),
                INSALES_MCP_AUTO_CLEANUP: '0',
                INSALES_MCP_API_ERROR_LOG: '0',
                INSALES_MCP_MODE: mode,
                INSALES_MCP_FULL_API: fullApi,
              },
              stderr: 'pipe',
            }),
          );
          const names = (await client.listTools()).tools.map(({ name }) => name);
          if (mode === 'code') {
            assert.deepEqual(names, ['execute_read', 'execute_write']);
            const response = await client.callTool({
              name: 'execute_read',
              arguments: { code: 'return await catalog.search({domain:"public_api"});' },
            });
            assert.ok(Array.isArray(response.content));
            const execution = JSON.parse(response.content[0].text);
            assert.equal(execution.result.total, fullApi === 'true' ? 293 : 0);
          } else {
            assert.ok(names.includes('theme_api'));
            assert.equal(names.includes('api_catalog'), fullApi === 'true');
          }
        } finally {
          await client.close();
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
