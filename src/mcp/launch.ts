import { Fault } from '../shared/common.js';
import { serve } from './transports/stdio.js';

export function parseLaunchArguments(args: string[]): void {
  if (args.length === 0) return;
  if (args.length === 1 && args[0] === '--transport=stdio') return;
  if (args.length === 2 && args[0] === '--transport' && args[1] === 'stdio') return;
  throw new Fault('invalid_config', 'Допустим только --transport=stdio.');
}

export async function launch(args = process.argv.slice(2)) {
  parseLaunchArguments(args);
  return serve();
}
