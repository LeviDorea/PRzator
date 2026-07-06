import { createHash } from 'crypto';
import { normalizePath } from '../common/utils/file-language.util';
import { GeneralIssue, ReviewIssue } from './review-issue.types';

type IssueKeyInput = Pick<ReviewIssue, 'rule' | 'file' | 'reason' | 'description'>;
type GeneralIssueKeyInput = Pick<GeneralIssue, 'file' | 'reason' | 'description'>;
type IssueSnippetInput = Pick<ReviewIssue, 'file' | 'snippet'>;
type DiffLikeFile = { filename: string; patch: string };

export function buildIssueKey(issue: IssueKeyInput): string {
  const source = [
    normalizeText(issue.rule),
    normalizeText(issue.file),
    normalizeText(issue.reason || issue.description),
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
