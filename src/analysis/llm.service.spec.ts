import { LlmService } from './llm.service';
import { DiffService } from './diff.service';
import { buildGeneralIssueKey } from './review-issue.util';
import type { FileRulesContext } from '../rules/rules.service';

jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    withStructuredOutput: jest.fn().mockReturnValue({
      invoke: jest.fn(),
    }),
  })),
}));

import { ChatOpenAI } from '@langchain/openai';

const mockConfig = {
  get: (key: string) => {
    const map: Record<string, string> = {
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'test-key',
      MAX_DIFF_TOKENS: '80000',
    };
    return map[key] ?? '';
  },
};

const RULES: FileRulesContext[] = [
  {
    filename: 'src/app.ts',
    language: 'typescript',
    rules: [{ title: 'Security', description: 'Check for vulnerabilities', criticality: 'high' }],
  },
];
const FILES = [
  {
    filename: 'src/app.ts',
    patch: '@@ -1 +1 @@\n-const secret = oldSecret;\n+const secret = "hardcoded";',
    status: 'modified',
  },
];

describe('LlmService', () => {
  let mockInvoke: jest.Mock;
  const oversizedPromptError = Object.assign(
    new Error(
      '429 Request too large for gpt-4o in organization org-test on tokens per min (TPM): Limit 30000, Requested 30265.',
    ),
    { status: 429 },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke = jest.fn().mockResolvedValue({ issues: [] });
    (ChatOpenAI as unknown as jest.Mock).mockImplementation(() => ({
      withStructuredOutput: jest.fn().mockReturnValue({ invoke: mockInvoke }),
    }));
  });

  it('should return empty array when LLM finds no issues', async () => {
    mockInvoke.mockResolvedValue({ issues: [] });
    const svc = new LlmService(mockConfig as any, new DiffService());
    const result = await svc.analyze('PR title', 'PR body', FILES, '', RULES);
    expect(result).toEqual([]);
  });

  it('should return issues found by LLM', async () => {
    const mockIssue = {
      file: 'src/app.ts',
      snippet: 'const secret = "hardcoded"',
      description: 'Hardcoded secret',
      reason: 'Security risk',
      criticality: 'high' as const,
      rule: 'Security',
    };
    mockInvoke.mockResolvedValue({ issues: [mockIssue] });

    const svc = new LlmService(mockConfig as any, new DiffService());
    const result = await svc.analyze('PR title', '', FILES, '', RULES);

    expect(result).toHaveLength(1);
    expect(result[0].criticality).toBe('high');
    expect(result[0].issueKey).toEqual(expect.any(String));
    expect(result[0].advisory).toBeUndefined();
  });

  it('should split into batches when diff exceeds maxTokens', async () => {
    mockInvoke.mockResolvedValue({ issues: [] });

    const tinyTokenConfig = {
      get: (key: string) => {
        if (key === 'MAX_DIFF_TOKENS') return '10';
        if (key === 'OPENAI_MODEL') return 'gpt-4o';
        if (key === 'OPENAI_API_KEY') return 'key';
        return '';
      },
    };

    const largeFiles = [
      { filename: 'src/a.ts', patch: `@@ -1 +1 @@\n+${'a'.repeat(100)}`, status: 'modified' },
      { filename: 'src/b.ts', patch: `@@ -1 +1 @@\n+${'b'.repeat(100)}`, status: 'modified' },
    ];
    const largeFileRules: FileRulesContext[] = [
      {
        filename: 'src/a.ts',
        language: 'typescript',
        rules: [{ title: 'Security', description: 'Check A', criticality: 'high' }],
      },
      {
        filename: 'src/b.ts',
        language: 'typescript',
        rules: [{ title: 'Security', description: 'Check B', criticality: 'high' }],
      },
    ];

    const svc = new LlmService(tinyTokenConfig as any, new DiffService());
    await svc.analyze('PR', 'body', largeFiles, '', largeFileRules);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('should include only file-specific rules in the prompt', async () => {
    const svc = new LlmService(mockConfig as any, new DiffService());

    await svc.analyze(
      'PR title',
      'PR body',
      [
        { filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+const secret = "hardcoded";', status: 'modified' },
        { filename: 'README.md', patch: '@@ -1 +1 @@\n+docs', status: 'modified' },
      ],
      '',
      [
        {
          filename: 'src/app.ts',
          language: 'typescript',
          rules: [{ title: 'Security', description: 'Check for vulnerabilities', criticality: 'high' }],
        },
        {
          filename: 'README.md',
          language: 'markdown',
          rules: [],
        },
      ],
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const prompt = mockInvoke.mock.calls[0][0] as string;
    expect(prompt).toContain('### src/app.ts (modified)');
    expect(prompt).toContain('Applicable Rules:');
    expect(prompt).toContain('Security');
    expect(prompt).not.toContain('### README.md (modified)');
  });

  it('should deduplicate repeated issues across batches using rule, file, and root cause', async () => {
    const duplicateIssue = {
      file: 'src/a.ts',
      snippet: 'danger()',
      description: 'Shared issue',
      reason: 'Repeated root cause',
      criticality: 'high' as const,
      rule: 'Security',
    };

    mockInvoke
      .mockResolvedValueOnce({ issues: [duplicateIssue] })
      .mockResolvedValueOnce({ issues: [duplicateIssue] });

    const tinyTokenConfig = {
      get: (key: string) => {
        if (key === 'MAX_DIFF_TOKENS') return '10';
        if (key === 'OPENAI_MODEL') return 'gpt-4o';
        if (key === 'OPENAI_API_KEY') return 'key';
        return '';
      },
    };

    const svc = new LlmService(tinyTokenConfig as any, new DiffService());
    const result = await svc.analyze(
      'PR',
      'body',
      [
        { filename: 'src/a.ts', patch: `@@ -1 +1 @@\n+${'a'.repeat(90)}\n+danger()`, status: 'modified' },
        { filename: 'src/b.ts', patch: `@@ -1 +1 @@\n+${'b'.repeat(90)}\n+otherDanger()`, status: 'modified' },
      ],
      '',
      [
        {
          filename: 'src/a.ts',
          language: 'typescript',
          rules: [{ title: 'Security', description: 'Check A', criticality: 'high' }],
        },
        {
          filename: 'src/b.ts',
          language: 'typescript',
          rules: [{ title: 'Security', description: 'Check B', criticality: 'high' }],
        },
      ],
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/a.ts');
  });

  it('should retry without shared context when the prompt is too large', async () => {
    mockInvoke
      .mockRejectedValueOnce(oversizedPromptError)
      .mockResolvedValueOnce({ issues: [] });

    const svc = new LlmService(mockConfig as any, new DiffService());
    await svc.analyze(
      'PR title',
      'PR body',
      FILES,
      '// Context only. Do not report standalone issues for this file.\n// File: src/shared.ts\nexport const helper = true;',
      RULES,
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke.mock.calls[0][0]).toContain('## Shared/Imported Files Context');
    expect(mockInvoke.mock.calls[1][0]).not.toContain(
      '## Shared/Imported Files Context',
    );
  });

  it('should split an oversized batch into smaller prompts', async () => {
    mockInvoke
      .mockRejectedValueOnce(oversizedPromptError)
      .mockResolvedValueOnce({
        issues: [
          {
            file: 'src/a.ts',
            snippet: 'dangerA()',
            description: 'Issue A',
            reason: 'Cause A',
            criticality: 'high' as const,
            rule: 'Security',
          },
        ],
      })
      .mockResolvedValueOnce({
        issues: [
          {
            file: 'src/b.ts',
            snippet: 'dangerB()',
            description: 'Issue B',
            reason: 'Cause B',
            criticality: 'medium' as const,
            rule: 'Security',
          },
        ],
      });

    const svc = new LlmService(mockConfig as any, new DiffService());
    const result = await svc.analyze(
      'PR title',
      'PR body',
      [
        { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n+dangerA()', status: 'modified' },
        { filename: 'src/b.ts', patch: '@@ -1 +1 @@\n+dangerB()', status: 'modified' },
      ],
      '',
      [
        {
          filename: 'src/a.ts',
          language: 'typescript',
          rules: [{ title: 'Security', description: 'Check A', criticality: 'high' }],
        },
        {
          filename: 'src/b.ts',
          language: 'typescript',
          rules: [{ title: 'Security', description: 'Check B', criticality: 'medium' }],
        },
      ],
    );

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(mockInvoke.mock.calls[0][0]).toContain('### src/a.ts (modified)');
    expect(mockInvoke.mock.calls[0][0]).toContain('### src/b.ts (modified)');
    expect(mockInvoke.mock.calls[1][0]).toContain('### src/a.ts (modified)');
    expect(mockInvoke.mock.calls[1][0]).not.toContain('### src/b.ts (modified)');
    expect(mockInvoke.mock.calls[2][0]).toContain('### src/b.ts (modified)');
    expect(mockInvoke.mock.calls[2][0]).not.toContain('### src/a.ts (modified)');
    expect(result).toHaveLength(2);
  });

  it('should preserve all diff-matching issues for downstream baseline and cap handling', async () => {
    const svc = new LlmService(mockConfig as any, new DiffService());
    mockInvoke.mockResolvedValue({
      issues: [
        {
          file: 'src/one.ts',
          snippet: 'a()',
          description: 'Issue 1',
          reason: 'Cause 1',
          criticality: 'high' as const,
          rule: 'Security',
        },
        {
          file: 'src/two.ts',
          snippet: 'b()',
          description: 'Issue 2',
          reason: 'Cause 2',
          criticality: 'high' as const,
          rule: 'Security',
        },
        {
          file: 'src/three.ts',
          snippet: 'c()',
          description: 'Issue 3',
          reason: 'Cause 3',
          criticality: 'high' as const,
          rule: 'Security',
        },
        {
          file: 'src/four.ts',
          snippet: 'd()',
          description: 'Issue 4',
          reason: 'Cause 4',
          criticality: 'high' as const,
          rule: 'Security',
        },
      ],
    });
    const result = await svc.analyze(
      'PR title',
      '',
      [
        { filename: 'src/one.ts', patch: '@@ -1 +1 @@\n+a()', status: 'modified' },
        { filename: 'src/two.ts', patch: '@@ -1 +1 @@\n+b()', status: 'modified' },
        { filename: 'src/three.ts', patch: '@@ -1 +1 @@\n+c()', status: 'modified' },
        { filename: 'src/four.ts', patch: '@@ -1 +1 @@\n+d()', status: 'modified' },
      ],
      '',
      [
        { filename: 'src/one.ts', language: 'typescript', rules: [{ title: 'Security', description: 'Check 1', criticality: 'high' }] },
        { filename: 'src/two.ts', language: 'typescript', rules: [{ title: 'Security', description: 'Check 2', criticality: 'high' }] },
        { filename: 'src/three.ts', language: 'typescript', rules: [{ title: 'Security', description: 'Check 3', criticality: 'high' }] },
        { filename: 'src/four.ts', language: 'typescript', rules: [{ title: 'Security', description: 'Check 4', criticality: 'high' }] },
      ],
    );

    expect(result).toHaveLength(4);
    expect(result.every((issue) => issue.advisory === undefined)).toBe(true);
    expect(result.every((issue) => typeof issue.issueKey === 'string')).toBe(true);
  });

  it('should discard issues that target context files or snippets outside diff hunks', async () => {
    mockInvoke.mockResolvedValue({
      issues: [
        {
          file: 'src/app.ts',
          snippet: 'const secret = "hardcoded";',
          description: 'Valid diff issue',
          reason: 'Changed insecure code',
          criticality: 'high' as const,
          rule: 'Security',
        },
        {
          file: 'src/shared.ts',
          snippet: 'danger()',
          description: 'Context-only file',
          reason: 'Should not be reported',
          criticality: 'high' as const,
          rule: 'Security',
        },
        {
          file: 'src/app.ts',
          snippet: 'const untouched = true;',
          description: 'Outside hunk',
          reason: 'Snippet not in diff hunk',
          criticality: 'medium' as const,
          rule: 'Security',
        },
      ],
    });

    const svc = new LlmService(mockConfig as any, new DiffService());
    const result = await svc.analyze('PR title', '', FILES, '// File: src/shared.ts\nexport const danger = true;', RULES);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Valid diff issue');
  });

  it('should run PR-scoped rules once across the whole PR even without file-scoped rules', async () => {
    mockInvoke.mockResolvedValue({
      issues: [
        {
          file: 'src/app.ts',
          snippet: 'export function saveOrder() {}',
          description: 'Missing PR-level companion coverage',
          reason: 'The changed behavior has no matching test update anywhere else in the PR.',
          criticality: 'high' as const,
          rule: 'Controller changes need tests',
        },
      ],
    });

    const svc = new LlmService(mockConfig as any, new DiffService());
    const result = await svc.analyze(
      'PR title',
      'PR body',
      [
        { filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+export function saveOrder() {}', status: 'modified' },
        { filename: 'src/app.spec.ts', patch: '@@ -1 +1 @@\n+describe(\"noop\")', status: 'modified' },
      ],
      '',
      [],
      [
        {
          title: 'Controller changes need tests',
          description: 'Behavior changes must ship with matching tests somewhere in the PR.',
          criticality: 'high',
          scope: 'pr',
          whyThisRuleExists: 'This repo treats coverage as a PR-level requirement.',
        },
      ],
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toContain('## PR-Level Rules');
    expect(mockInvoke.mock.calls[0][0]).toContain('### src/app.ts (modified)');
    expect(mockInvoke.mock.calls[0][0]).toContain('### src/app.spec.ts (modified)');
    expect(result).toHaveLength(1);
    expect(result[0].rule).toBe('Controller changes need tests');
  });

  it('should render the full file content alongside the diff when attached', async () => {
    mockInvoke.mockResolvedValue({ issues: [] });
    const svc = new LlmService(mockConfig as any, new DiffService());

    await svc.analyze(
      'PR title',
      'PR body',
      [
        {
          filename: 'src/app.ts',
          patch: '@@ -5 +5 @@\n+export function saveOrder() {}',
          status: 'modified',
          fullContent: 'const declaredAtTop = true;\nexport function saveOrder() {}',
        },
      ],
      '',
      RULES,
    );

    const prompt = mockInvoke.mock.calls[0][0];
    expect(prompt).toContain('Current file at head (full content):');
    expect(prompt).toContain('const declaredAtTop = true;');
    expect(prompt).toContain('Changes in this PR:');
    expect(prompt).toContain('+export function saveOrder() {}');
  });

  describe('critiqueIssues', () => {
    const criticIssues = [
      {
        file: 'a.php',
        snippet: 'public function warRoom() {}',
        description: 'Model used without $uses declaration.',
        reason: 'Uses Pedido without declaring it.',
        criticality: 'medium' as const,
        rule: '$uses',
        issueKey: 'k1',
      },
      {
        file: 'a.php',
        snippet: 'echo $x;',
        description: 'Unescaped output.',
        reason: 'No h() around $x.',
        criticality: 'high' as const,
        rule: 'Escaping',
        issueKey: 'k2',
      },
    ];
    const criticContents = [{ path: 'a.php', content: "public $uses = ['Pedido'];" }];

    it('should return only refuted issueKeys it knows about', async () => {
      mockInvoke.mockResolvedValue({
        verdicts: [
          { issueKey: 'k1', verdict: 'refuted', reason: "file declares public $uses = ['Pedido']" },
          { issueKey: 'k2', verdict: 'confirmed', reason: 'no escaping visible' },
          { issueKey: 'ghost', verdict: 'refuted', reason: 'unknown key must be ignored' },
        ],
      });
      const svc = new LlmService(mockConfig as any, new DiffService());

      const refuted = await svc.critiqueIssues(criticIssues as any, criticContents);

      expect(refuted).toEqual(new Set(['k1']));
      expect(mockInvoke.mock.calls[0][0]).toContain('issueKey: k1');
      expect(mockInvoke.mock.calls[0][0]).toContain("public $uses = ['Pedido'];");
    });

    it('should fail open with an empty set when the critic prompt is too large', async () => {
      mockInvoke.mockRejectedValue(oversizedPromptError);
      const svc = new LlmService(mockConfig as any, new DiffService());

      const refuted = await svc.critiqueIssues(criticIssues as any, criticContents);
      expect(refuted).toEqual(new Set());
    });

    it('should not call the LLM without issues or file contents', async () => {
      const svc = new LlmService(mockConfig as any, new DiffService());

      expect(await svc.critiqueIssues([], criticContents)).toEqual(new Set());
      expect(await svc.critiqueIssues(criticIssues as any, [])).toEqual(new Set());
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('analyzeGeneral', () => {
    it('should run discovery mode and assign issueKeys when there are no previous issues', async () => {
      mockInvoke.mockResolvedValue({
        issues: [
          {
            file: 'src/app.ts',
            snippet: 'const secret = "hardcoded";',
            description: 'Undefined index risk',
            reason: 'Array access without isset check',
            criticality: 'medium' as const,
          },
        ],
      });

      const svc = new LlmService(mockConfig as any, new DiffService());
      const result = await svc.analyzeGeneral('PR title', 'PR body', FILES, undefined, []);

      expect(result).toHaveLength(1);
      expect(result[0].issueKey).toEqual(expect.any(String));
      expect((result[0] as any).rule).toBeUndefined();
    });

    it('should retry without AGENTS.md context when the discovery prompt is too large', async () => {
      mockInvoke
        .mockRejectedValueOnce(oversizedPromptError)
        .mockResolvedValueOnce({ issues: [] });

      const svc = new LlmService(mockConfig as any, new DiffService());
      await svc.analyzeGeneral(
        'PR title',
        'PR body',
        FILES,
        '## Conventions\nSome long AGENTS.md content.',
        [],
      );

      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockInvoke.mock.calls[0][0]).toContain('## Repository Context (AGENTS.md)');
      expect(mockInvoke.mock.calls[1][0]).not.toContain('## Repository Context (AGENTS.md)');
    });

    it('should not exhaust retries on a prompt-too-large error in discovery mode', async () => {
      mockInvoke.mockRejectedValue(oversizedPromptError);

      const svc = new LlmService(mockConfig as any, new DiffService());

      await expect(
        svc.analyzeGeneral('PR title', 'PR body', FILES, undefined, []),
      ).rejects.toBe(oversizedPromptError);

      // No AGENTS.md to drop, single file so no further split possible: exactly one real attempt.
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('should not call the LLM in discovery mode when there are no changed files', async () => {
      const svc = new LlmService(mockConfig as any, new DiffService());
      const result = await svc.analyzeGeneral('PR title', 'PR body', [], undefined, []);

      expect(result).toEqual([]);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should run verify mode and only keep previously found issues confirmed still present', async () => {
      const resolvedIssue = {
        file: 'src/app.ts',
        snippet: 'const secret = "hardcoded";',
        description: 'Resolved issue',
        reason: 'Already fixed',
        criticality: 'medium' as const,
        issueKey: buildGeneralIssueKey({
          file: 'src/app.ts',
          description: 'Resolved issue',
          reason: 'Already fixed',
        }),
      };
      const stillPresentIssue = {
        file: 'src/app.ts',
        snippet: 'const secret = "hardcoded";',
        description: 'Still present issue',
        reason: 'Not fixed yet',
        criticality: 'high' as const,
        issueKey: buildGeneralIssueKey({
          file: 'src/app.ts',
          description: 'Still present issue',
          reason: 'Not fixed yet',
        }),
      };

      mockInvoke.mockResolvedValue({
        stillPresentIssueKeys: [stillPresentIssue.issueKey],
      });

      const svc = new LlmService(mockConfig as any, new DiffService());
      const result = await svc.analyzeGeneral('PR title', 'PR body', FILES, undefined, [
        resolvedIssue,
        stillPresentIssue,
      ]);

      expect(result).toEqual([stillPresentIssue]);
    });

    it('should discover new general issues only from the incremental diff after verifying previous ones', async () => {
      const previousIssue = {
        file: 'src/app.ts',
        snippet: 'persist()',
        description: 'Previous issue',
        reason: 'Still present',
        criticality: 'high' as const,
        issueKey: buildGeneralIssueKey({
          file: 'src/app.ts',
          description: 'Previous issue',
          reason: 'Still present',
        }),
      };

      mockInvoke
        .mockResolvedValueOnce({
          stillPresentIssueKeys: [previousIssue.issueKey],
        })
        .mockResolvedValueOnce({
          issues: [
            {
              file: 'src/new.ts',
              snippet: 'danger()',
              description: 'New incremental issue',
              reason: 'New code introduced a bug',
              criticality: 'medium' as const,
            },
          ],
        });

      const svc = new LlmService(mockConfig as any, new DiffService());
      const result = await svc.analyzeGeneral(
        'PR title',
        'PR body',
        [
          { filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+persist()', status: 'modified' },
          { filename: 'src/new.ts', patch: '@@ -1 +1 @@\n+danger()', status: 'modified' },
        ],
        undefined,
        [previousIssue],
        [{ filename: 'src/new.ts', patch: '@@ -1 +1 @@\n+danger()', status: 'modified' }],
      );

      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          previousIssue,
          expect.objectContaining({
            file: 'src/new.ts',
            description: 'New incremental issue',
            issueKey: expect.any(String),
          }),
        ]),
      );
    });

    it('should never invent a new issue in verify mode even if the LLM returns an unknown key', async () => {
      const previousIssue = {
        file: 'src/app.ts',
        snippet: 'const secret = "hardcoded";',
        description: 'Previous issue',
        reason: 'Not fixed yet',
        criticality: 'high' as const,
        issueKey: buildGeneralIssueKey({
          file: 'src/app.ts',
          description: 'Previous issue',
          reason: 'Not fixed yet',
        }),
      };

      mockInvoke.mockResolvedValue({
        stillPresentIssueKeys: [previousIssue.issueKey, 'some-hallucinated-key'],
      });

      const svc = new LlmService(mockConfig as any, new DiffService());
      const result = await svc.analyzeGeneral('PR title', 'PR body', FILES, undefined, [
        previousIssue,
      ]);

      expect(result).toEqual([previousIssue]);
    });

    it('should not call the LLM in verify mode when none of the previous issue files changed', async () => {
      const previousIssue = {
        file: 'src/other-file.ts',
        snippet: 'x',
        description: 'Previous issue',
        reason: 'Not fixed yet',
        criticality: 'high' as const,
        issueKey: 'some-key',
      };

      const svc = new LlmService(mockConfig as any, new DiffService());
      const result = await svc.analyzeGeneral('PR title', 'PR body', FILES, undefined, [
        previousIssue,
      ]);

      expect(result).toEqual([]);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});
