export const MCP_ACCESS = ['full', 'theme_files'] as const;
export type McpAccess = (typeof MCP_ACCESS)[number];

const THEME_FILES_PREFIXES = ['/admin/theme_editor/v1', '/admin/themes', '/admin/files'] as const;

/** Запись в режиме theme_files: темы, виджеты, блоки и раздел «Файлы». */
export function themeFilesWriteAllowed(path: string) {
  let url: URL;
  try {
    url = new URL(path, 'https://api.invalid');
  } catch {
    return false;
  }
  if (url.origin !== 'https://api.invalid') return false;
  const { pathname } = url;
  return THEME_FILES_PREFIXES.some(
    (prefix) =>
      pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`),
  );
}
