import { Api } from '../api.js';
import { startApiErrorLog } from '../infrastructure/logging/api-error-log.js';
import { autoCleanupEnabled, startAutoCleanup } from '../infrastructure/persistence/cleanup.js';
import { configFromEnvironment, mcpOptionsFromEnvironment, type RuntimeConfig } from './config.js';
import { ChangeCoordinator } from '../changes/coordinator.js';
import { Knowledge } from '../infrastructure/knowledge/index.js';
import { State } from '../infrastructure/persistence/state.js';
import { ActiveCalls } from './active-calls.js';

/** Owns resources used by the MCP server in this process. */
export function createApplication(
  config: RuntimeConfig | undefined = configFromEnvironment(),
  options: { dataDirectory?: string; autoCleanup?: boolean } = {},
) {
  const mcpOptions = mcpOptionsFromEnvironment();
  autoCleanupEnabled();
  const apiErrorLog = startApiErrorLog();
  const state = new State(options.dataDirectory, config?.store);
  let knowledge: Knowledge;
  try {
    knowledge = new Knowledge();
  } catch (error) {
    state.close();
    throw error;
  }
  const api = new Api(
    state,
    config?.credentials,
    undefined,
    apiErrorLog,
    mcpOptions.themeId,
    mcpOptions.access,
  );
  const engine = new ChangeCoordinator(api);
  const calls = new ActiveCalls();
  const stopCleanup = options.autoCleanup === false ? async () => {} : startAutoCleanup(state);
  let disposal: Promise<void> | undefined;

  return {
    engine,
    mcpOptions,
    knowledge,
    calls,
    dispose() {
      disposal ??= (async () => {
        await stopCleanup();
        await calls.drain();
        knowledge.close();
        await api.close();
        state.close();
      })();
      return disposal;
    },
  };
}
