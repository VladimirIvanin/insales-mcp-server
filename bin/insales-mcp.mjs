#!/usr/bin/env node
import { launch } from '../dist/src/mcp/launch.js';
import { errorResult } from '../dist/src/shared/common.js';

try {
  await launch();
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
}
