const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  node: 'javascript',
  py: 'python',
  python: 'python',
  java: 'java',
  rb: 'ruby',
  go: 'go',
  php: 'php',
  sql: 'sql',
  cs: 'csharp',
  'c#': 'csharp',
  csharp: 'csharp',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  env: 'env',
  dockerfile: 'dockerfile',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  markdown: 'markdown',
};

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function detectLanguageFromFilename(filename: string): string | null {
  const normalizedFilename = normalizePath(filename);
  const parts = normalizedFilename.split('/');
  const basename = parts[parts.length - 1] ?? normalizedFilename;
  const basenameLower = basename.toLowerCase();

  if (basenameLower === 'dockerfile' || basenameLower.startsWith('dockerfile.')) {
    return 'dockerfile';
  }

  if (basenameLower === '.env' || basenameLower.startsWith('.env.')) {
    return 'env';
  }

  const segments = basename.split('.');

  if (segments.length < 2) {
    return null;
  }

  const extension = segments[segments.length - 1]?.toLowerCase() ?? '';
  return LANGUAGE_ALIASES[extension] ?? null;
}
