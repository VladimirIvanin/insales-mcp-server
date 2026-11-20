import { z } from 'zod';
import type { ToolContext } from '../tool-context.js';

export function registerKnowledgeTools(context: ToolContext) {
  const { knowledge, widgetStandards, tool } = context;
  const scenarioGuides = {
    create_widget: 'create-widget',
    edit_widget: 'edit-widget',
    fill_content: 'fill-content',
    transfer_design: 'transfer-design',
  } as const;
  const patternGuides = {
    blocks: 'blocks',
    runtime: 'runtime',
    sliders: 'sliders',
    product_forms: 'product-forms',
    content_and_design: 'content-and-design',
    antipatterns: 'antipatterns',
    fallback_images: 'fallback-images',
  } as const;
  tool(
    'search_knowledge',
    'Найти правила InSales. detail=sections сразу вернёт текст лучших разделов и уменьшит число вызовов.',
    {
      query: z.string().min(1).max(500),
      topic: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(10).default(5),
      detail: z.enum(['snippets', 'sections']).default('snippets'),
    },
    (a) => knowledge.search(a.query, a.topic, a.limit, a.detail),
  );
  tool(
    'get_knowledge_section',
    'Прочитать раздел из search_knowledge с источником и версией.',
    { id: z.string().max(500), offset: z.number().int().min(0).default(0) },
    (a) => knowledge.get(a.id, a.offset),
  );
  tool(
    'get_widget_standards',
    'Правила разработки виджетов InSales. Для поколения 4 settings_form строго содержит content и design — массивы групп с items. Без scenario и patterns возвращает общие стандарты. Для create_widget и blocks автоматически включает базовые fallback_id изображений для setup.json с назначением, размерами и соотношением сторон; отдельно запросите patterns=[fallback_images]. Для виджета карточки товара запросите patterns=[product_forms]: там есть проверка на разных существующих товарах. При выборе руководств по умолчанию возвращает их текст и только ссылку на общие стандарты; detail=full включает полный общий текст.',
    {
      scenario: z
        .enum(['create_widget', 'edit_widget', 'fill_content', 'transfer_design'])
        .optional(),
      patterns: z
        .array(
          z.enum([
            'blocks',
            'runtime',
            'sliders',
            'product_forms',
            'content_and_design',
            'antipatterns',
            'fallback_images',
          ]),
        )
        .max(7)
        .optional(),
      detail: z.enum(['compact', 'full']).default('compact'),
    },
    (a) => {
      if (!a.scenario && !a.patterns?.length) return widgetStandards;
      const guideNames = [
        ...(a.scenario ? [scenarioGuides[a.scenario]] : []),
        ...(a.patterns ?? []).map((pattern) => patternGuides[pattern]),
        ...(['create_widget', 'transfer_design'].includes(a.scenario ?? '')
          ? ['content-and-design', 'antipatterns']
          : []),
        ...(a.scenario === 'create_widget' || a.patterns?.includes('blocks')
          ? ['fallback-images']
          : []),
      ];
      return {
        ...(a.detail === 'full'
          ? widgetStandards
          : {
              id: widgetStandards.id,
              title: widgetStandards.title,
              source: widgetStandards.source,
              version: widgetStandards.version,
              content_hash: widgetStandards.content_hash,
              trust: widgetStandards.trust,
            }),
        guides: [...new Set(guideNames)].map((name) =>
          knowledge.get(`guide/widget-development/${name}.md#0`),
        ),
      };
    },
  );
}
