import {
  buildIssueKey,
  isEnvVarOnlySecretFinding,
  issueMatchesDiff,
  snippetExistsInContent,
} from './review-issue.util';

describe('isEnvVarOnlySecretFinding', () => {
  it('treats a shell env-var reference as a false positive', () => {
    expect(isEnvVarOnlySecretFinding('mysql -uroot -p"${MYSQL_ROOT_PASSWORD}"')).toBe(true);
    expect(isEnvVarOnlySecretFinding('password=${MYSQL_ROOT_PASSWORD}')).toBe(true);
    expect(isEnvVarOnlySecretFinding('export TOKEN=$GITHUB_TOKEN')).toBe(true);
  });

  it('treats process.env / os.environ references as false positives', () => {
    expect(isEnvVarOnlySecretFinding('const apiKey = process.env.API_KEY;')).toBe(true);
    expect(isEnvVarOnlySecretFinding("db_pass = os.environ['DB_PASSWORD']")).toBe(true);
    expect(isEnvVarOnlySecretFinding("token = process.env['GH_TOKEN']")).toBe(true);
  });

  it('keeps a real hardcoded credential literal', () => {
    expect(isEnvVarOnlySecretFinding('const apiKey = "sk-live-4f9a1c8b2e";')).toBe(false);
    expect(isEnvVarOnlySecretFinding('token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";')).toBe(
      false,
    );
    expect(isEnvVarOnlySecretFinding('key = "-----BEGIN RSA PRIVATE KEY-----"')).toBe(false);
  });

  it('keeps a snippet mixing an env ref AND a literal secret', () => {
    expect(
      isEnvVarOnlySecretFinding('const apiKey = process.env.API_KEY || "sk-live-9f2a1c8b7e4d";'),
    ).toBe(false);
  });

  it('keeps a long high-entropy quoted literal even without a known prefix', () => {
    expect(isEnvVarOnlySecretFinding('password=${DB} // was "aB3xK9mQ7pL2wZ8t"')).toBe(false);
  });

  it('does not suppress when there is no env-var reference at all', () => {
    expect(isEnvVarOnlySecretFinding('const x = "changeme";')).toBe(false);
    expect(isEnvVarOnlySecretFinding('')).toBe(false);
  });
});

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
