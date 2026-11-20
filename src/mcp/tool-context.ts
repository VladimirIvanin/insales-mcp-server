import type { ChangeCoordinator } from '../changes/coordinator.js';
import type { Knowledge } from '../infrastructure/knowledge/index.js';
import type { ToolRegistrar } from './register-tool.js';

export interface ToolContext {
  engine: ChangeCoordinator;
  knowledge: Knowledge;
  widgetStandards: ReturnType<Knowledge['get']> & { trust: string };
  tool: ToolRegistrar;
}
