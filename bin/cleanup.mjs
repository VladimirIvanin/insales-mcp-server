#!/usr/bin/env node
import { State } from '../dist/src/infrastructure/persistence/state.js';
import { cleanup } from '../dist/src/infrastructure/persistence/cleanup.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--apply')) {
  process.stderr.write('Использование: npm run cleanup [-- --apply]\n');
  process.exitCode = 2;
} else {
  const state = new State();
  try {
    const report = await cleanup(state, {
      apply: args.includes('--apply'),
      compact: args.includes('--apply'),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Очистка не завершена: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    state.close();
  }
}
