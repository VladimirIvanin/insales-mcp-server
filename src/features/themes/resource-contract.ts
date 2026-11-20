import { themesAndSettings, themeBackups } from './resource-contract/themes.js';
import { themeAssets, storeFiles } from './resource-contract/assets.js';
import { widgetTypes, widgets, widgetTypeUsage } from './resource-contract/widgets.js';
import { widgetBlocks, blocks, panelBlock } from './resource-contract/blocks.js';
import { widgetLists } from './resource-contract/widget-lists.js';
import { libraries } from './resource-contract/libraries.js';
import { pageTemplates, pageRendering } from './resource-contract/pages.js';
import { themeHistory } from './resource-contract/history.js';

export const themeResourceContract = [
  ...themesAndSettings,
  ...themeAssets,
  ...widgetTypes,
  ...widgets,
  ...widgetBlocks,
  ...widgetLists,
  ...blocks,
  ...libraries,
  ...pageTemplates,
  ...themeBackups,
  ...storeFiles,
  ...widgetTypeUsage,
  ...themeHistory,
  ...pageRendering,
  ...panelBlock,
] as const;
