import { createHash } from 'crypto';
import { normalizePath } from '../common/utils/file-language.util';
import { GeneralIssue, ReviewIssue } from './review-issue.types';

type IssueKeyInput = Pick<ReviewIssue, 'rule' | 'file' | 'snippet'>;
type GeneralIssueKeyInput = Pick<GeneralIssue, 'file' | 'reason' | 'description'>;
type IssueSnippetInput = Pick<ReviewIssue, 'file' | 'snippet'>;
type DiffLikeFile = { filename: string; patch: string };

export function buildIssueKey(issue: IssueKeyInput): string {
  const source = [
    normalizeText(issue.rule),
    normalizeText(normalizePath(issue.file)),
    normalizeCodeSnippet(issue.snippet),
  ].join('::');

  return createHash('sha256').update(source).digest('hex');
}

export function buildGeneralIssueKey(issue: GeneralIssueKeyInput): string {
  const source = [
    normalizeText(issue.file),
    normalizeText(issue.reason || issue.description),
  ].join('::');

  return createHash('sha256').update(source).digest('hex');
}

export function issueMatchesDiff(
  issue: IssueSnippetInput,
  files: DiffLikeFile[],
): boolean {
  const diffLookup = new Map(
    files.map((file) => [normalizePath(file.filename), buildDiffSnippetIndex(file.patch)]),
  );

  const fileIndex = diffLookup.get(normalizePath(issue.file));
  if (!fileIndex) {
    return false;
  }

  return matchesDiffSnippet(issue.snippet, fileIndex);
}

// Patterns that read a secret FROM an environment variable — the correct,
// non-hardcoded pattern, across shells/languages. Global so `.replace` strips all.
const ENV_VAR_REFERENCE_PATTERNS: RegExp[] = [
  /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, // ${VAR}
  /\$[A-Za-z_][A-Za-z0-9_]*/g, // $VAR
  /process\.env\.[A-Za-z_$][\w$]*/g, // process.env.X
  /process\.env\[\s*['"][^'"]+['"]\s*\]/g, // process.env['X']
  /os\.environ(?:\.get)?\s*[[(]\s*['"][^'"]+['"]/g, // os.environ['X'] / os.environ.get('X')
  /System\.getenv\(\s*['"][^'"]+['"]\s*\)/g, // System.getenv("X")
  /ENV\[\s*['"][^'"]+['"]\s*\]/g, // ENV['X'] (Ruby)
];

// Strong signals of a real, literal credential written in the source.
const SECRET_LITERAL_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z\-_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];

function looksLikeCredentialLiteral(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 16 &&
    !/\s/.test(trimmed) &&
    /[A-Za-z]/.test(trimmed) &&
    /[0-9]/.test(trimmed)
  );
}

/**
 * True when a "Secret Exposure" finding points at what is actually just an
 * environment-variable reference (e.g. `-p"${MYSQL_ROOT_PASSWORD}"`), with no
 * real hardcoded credential literal in the snippet. Used as a deterministic
 * guard to drop the LLM's false positives. Errs toward keeping (returns false)
 * whenever a plausible literal secret remains after stripping env-var refs.
 */
export function isEnvVarOnlySecretFinding(snippet: string): boolean {
  if (!snippet || !snippet.trim()) {
    return false;
  }

  const hasEnvRef = ENV_VAR_REFERENCE_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(snippet);
  });
  if (!hasEnvRef) {
    return false;
  }

  let stripped = snippet;
  for (const re of ENV_VAR_REFERENCE_PATTERNS) {
    stripped = stripped.replace(re, '');
  }

  if (SECRET_LITERAL_PATTERNS.some((re) => re.test(stripped))) {
    return false;
  }

  const quotedLiterals = stripped.match(/['"`]([^'"`]+)['"`]/g) ?? [];
  for (const literal of quotedLiterals) {
    if (looksLikeCredentialLiteral(literal.slice(1, -1))) {
      return false;
    }
  }

  return true;
}

export function snippetExistsInContent(snippet: string, content: string): boolean {
  const normalizedSnippet = normalizeCodeSnippet(snippet);
  if (!normalizedSnippet) {
    return false;
  }

  return normalizeCodeSnippet(content).includes(normalizedSnippet);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCodeSnippet(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function buildDiffSnippetIndex(patch: string): string[] {
  const snippets: string[] = [];
  let currentHunkLines: string[] = [];

  const flushHunk = () => {
    if (currentHunkLines.length === 0) {
      return;
    }

    const normalized = normalizeCodeSnippet(currentHunkLines.join('\n'));
    if (normalized) {
      snippets.push(normalized);
    }
    currentHunkLines = [];
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      flushHunk();
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+')) {
      currentHunkLines.push(line.slice(1));
    }
  }

  flushHunk();
  return snippets;
}

function matchesDiffSnippet(snippet: string, diffSnippets: string[]): boolean {
  const normalizedSnippet = normalizeCodeSnippet(snippet);
  if (!normalizedSnippet) {
    return false;
  }

  return diffSnippets.some((diffSnippet) => diffSnippet.includes(normalizedSnippet));
}
