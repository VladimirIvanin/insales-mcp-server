import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT, VERSION, Fault, revision } from '../../shared/common.js';

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(directory, e.name))
      : e.name.endsWith('.md')
        ? [join(directory, e.name)]
        : [],
  );
}
const synonyms: Record<string, string[]> = {
  кеш: ['cache', 'кеширование'],
  кэш: ['cache', 'кеш'],
  виджет: ['widget', 'виджет'],
  настройка: ['settings'],
  настройки: ['settings'],
  корзина: ['cart'],
  товар: ['product'],
  товары: ['products'],
  категория: ['collection'],
  категории: ['collections'],
  коллекция: ['collection'],
  событие: ['eventbus'],
  слайдер: ['tvist'],
  страница: ['page'],
  статья: ['article'],
};
export class Knowledge {
  private db = new DatabaseSync(':memory:');
  constructor(root = ROOT) {
    this.db.exec(
      'CREATE VIRTUAL TABLE sections USING fts5(id UNINDEXED,title,body,topic,source UNINDEXED,version UNINDEXED,tokenize="unicode61");',
    );
    const insert = this.db.prepare('INSERT INTO sections VALUES (?,?,?,?,?,?)');
    for (const [folder, upstream] of [
      ['knowledge', false],
      ['vendor/insales-coder/skills/insales-coder', true],
    ] as const) {
      for (const file of files(join(root, folder))) {
        const local = relative(join(root, folder), file).split(sep).join('/');
        const text = readFileSync(file, 'utf8');
        const topic = (local.split('/')[0] ?? '').replace(/\.md$/, '');
        const source = upstream
          ? `bundled:vendor/insales-coder/skills/insales-coder/${local}`
          : `bundled:knowledge/${local}`;
        // Keep fenced examples intact. Section IDs are stable within a package version.
        const lines = text.split('\n');
        let buffer: string[] = [];
        let title = local;
        let fence = false;
        let section = 0;
        const flush = () => {
          if (buffer.join('\n').trim())
            insert.run(
              `${upstream ? 'coder' : 'guide'}/${local}#${section++}`,
              title,
              buffer.join('\n'),
              topic,
              source,
              VERSION,
            );
          buffer = [];
        };
        for (const line of lines) {
          if (/^\s*(```|~~~)/.test(line)) fence = !fence;
          if (!fence && /^#{1,3} /.test(line)) {
            flush();
            title = line.replace(/^#+ /, '');
          }
          buffer.push(line);
        }
        flush();
      }
    }
  }
  search(query: string, topic?: string, limit = 5, detail: 'snippets' | 'sections' = 'snippets') {
    const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16);
    if (!tokens.length) return { items: [] };
    const expanded = [...new Set(tokens.flatMap((t) => [t, ...(synonyms[t] ?? [])]))];
    const match = expanded.map((t) => `"${t}"*`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT id,title,topic,source,version,snippet(sections,2,'','', ' … ',48) AS snippet FROM sections WHERE sections MATCH ? ${topic ? 'AND topic=?' : ''} ORDER BY bm25(sections,0,4,1,2,0,0) LIMIT ?`,
      )
      .all(...(topic ? [match, topic, limit] : [match, limit]));
    const items =
      detail === 'sections'
        ? rows.map((row, index) => {
            if (index >= 3) return row;
            if (typeof row.id !== 'string')
              throw new Fault('invalid_response', 'Не удалось прочитать раздел справочника.');
            const section = this.db.prepare('SELECT body FROM sections WHERE id=?').get(row.id);
            if (!section || typeof section.body !== 'string')
              throw new Fault('invalid_response', 'Не удалось прочитать раздел справочника.');
            return {
              ...row,
              body: section.body.slice(0, 6000),
              truncated: section.body.length > 6000,
            };
          })
        : rows;
    return {
      items,
      corpus_version: VERSION,
      retrieved_at: '2026-09-23',
      trust: 'reference_material_not_authorization',
    };
  }
  get(id: string, offset = 0) {
    const row = this.db.prepare('SELECT * FROM sections WHERE id=?').get(id);
    if (!row) throw new Fault('not_found', 'Раздел не найден. Используйте search_knowledge.');
    const body = String(row.body);
    const text = body.slice(offset, offset + 20000);
    return {
      id: row.id,
      title: row.title,
      topic: row.topic,
      source: row.source,
      version: row.version,
      body: text,
      offset,
      next_offset: offset + text.length < body.length ? offset + text.length : null,
      content_hash: revision(body),
      retrieved_at: '2026-09-22',
    };
  }
  count() {
    return Number(this.db.prepare('SELECT count(*) AS n FROM sections').get()!.n);
  }
  close() {
    this.db.close();
  }
}
