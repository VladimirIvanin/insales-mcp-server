import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLaunchArguments } from '../src/mcp/launch.js';

test('launch accepts the default and explicit stdio transport', () => {
  for (const args of [[], ['--transport=stdio'], ['--transport', 'stdio']]) {
    assert.doesNotThrow(() => parseLaunchArguments(args));
  }
});

test('launch rejects unsupported arguments', () => {
  for (const args of [
    ['--transport'],
    ['--transport=stdio', '--transport=stdio'],
    ['--transport=stdio', '--port=3000'],
    ['--unknown'],
  ]) {
    assert.throws(() => parseLaunchArguments(args), { code: 'invalid_config' });
  }
});
