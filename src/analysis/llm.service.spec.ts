import { LlmService } from './llm.service';
import { DiffService } from './diff.service';

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

const RULES = [{ title: 'Security', description: 'Check for vulnerabilities', criticality: 'high' }];
const FILES = [{ filename: 'src/app.ts', patch: '@@ -1 +1 @@ fix', status: 'modified' }];

describe('LlmService', () => {
  let mockInvoke: jest.Mock;

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
      { filename: 'src/a.ts', patch: 'a'.repeat(100), status: 'modified' },
      { filename: 'src/b.ts', patch: 'b'.repeat(100), status: 'modified' },
    ];

    const svc = new LlmService(tinyTokenConfig as any, new DiffService());
    await svc.analyze('PR', 'body', largeFiles, '', RULES);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
