import { buildIssueKey, issueMatchesDiff, snippetExistsInContent } from './review-issue.util';

describe('issueMatchesDiff', () => {
  it('matches a snippet that was added in the diff', () => {
    const issue = { file: 'src/app.ts', snippet: 'const secret = "hardcoded";' };
    const files = [
      {
        filename: 'src/app.ts',
        patch: '@@ -1,2 +1,2 @@\n-const secret = "";\n+const secret = "hardcoded";',
      },
    ];

    expect(issueMatchesDiff(issue, files)).toBe(true);
  });

  it('does not match a snippet that only appears as a removed line', () => {
    const issue = { file: 'src/app.ts', snippet: 'const secret = "hardcoded";' };
    const files = [
      {
        filename: 'src/app.ts',
        patch: '@@ -1,2 +1,2 @@\n-const secret = "hardcoded";\n+const secret = process.env.SECRET;',
      },
    ];

    expect(issueMatchesDiff(issue, files)).toBe(false);
  });

  it('does not match a snippet that only appears as unchanged context', () => {
    const issue = { file: 'src/app.ts', snippet: 'const unrelated = 1;' };
    const files = [
      {
        filename: 'src/app.ts',
        patch: '@@ -1,3 +1,3 @@\n const unrelated = 1;\n-const secret = "old";\n+const secret = "new";',
      },
    ];

    expect(issueMatchesDiff(issue, files)).toBe(false);
  });

  it('returns false when the file is not part of the diff', () => {
    const issue = { file: 'src/other.ts', snippet: 'foo()' };
    const files = [{ filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+foo()' }];

    expect(issueMatchesDiff(issue, files)).toBe(false);
  });
});

describe('snippetExistsInContent', () => {
  it('returns true when the snippet is present in the file content', () => {
    expect(snippetExistsInContent('const x = 1;', 'function f() {\n  const x = 1;\n}')).toBe(true);
  });

  it('returns false when the snippet is no longer present', () => {
    expect(snippetExistsInContent('login => cake2', "login => getenv('DB_USER')")).toBe(false);
  });

  it('returns false for an empty snippet', () => {
    expect(snippetExistsInContent('   ', 'anything')).toBe(false);
  });
});

describe('buildIssueKey', () => {
  it('is stable for the same rule/file/snippet regardless of casing or whitespace', () => {
    const a = buildIssueKey({
      rule: 'Security',
      file: 'src/app.ts',
      snippet: 'if (secret) {\n  leak(secret);\n}',
    });
    const b = buildIssueKey({
      rule: 'security',
      file: 'SRC/APP.TS',
      snippet: ' if (secret) {\n\n    leak(secret);\n } ',
    });

    expect(a).toBe(b);
  });

  it('differs when the snippet changes', () => {
    const a = buildIssueKey({
      rule: 'Security',
      file: 'src/app.ts',
      snippet: 'const secret = process.env.SECRET;',
    });
    const b = buildIssueKey({
      rule: 'Security',
      file: 'src/app.ts',
      snippet: 'const secret = process.env.API_KEY;',
    });

    expect(a).not.toBe(b);
  });
});
