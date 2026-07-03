import { AnalysisService } from './analysis.service';
import type { AnalysisRequestedEvent } from '../common/events/analysis.events';
import { ANALYSIS_COMPLETED, ANALYSIS_FAILED } from '../common/events/analysis.events';
import { buildIssueKey } from './review-issue.util';

const mockConfig = {
  get: (key: string) => {
    const map: Record<string, string> = {
      ISSUE_CAP_HIGH: '3',
      ISSUE_CAP_MEDIUM: '5',
      ISSUE_CAP_LOW: '5',
    };
    return map[key] ?? '';
  },
};

const mockPrisma = {
  analysis: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
  scoringConfig: {
    findFirst: jest.fn().mockResolvedValue({ high: 10, medium: 4, low: 1 }),
  },
};

const mockGithub = {
  getPRContext: jest.fn(),
  getPRFiles: jest.fn(),
  getCompareFiles: jest.fn(),
  getFileContent: jest.fn(),
};

const mockRules = {
  getActiveRulesForRepo: jest.fn(),
};

const mockLlm = {
  analyze: jest.fn(),
};

const mockDiff = {};

const mockSharedFiles = {
  fetchSharedFilesContext: jest.fn().mockResolvedValue(''),
};

const mockScoring = {
  calculate: jest.fn(),
};

const mockEmitter = {
  emit: jest.fn(),
};

const EVENT: AnalysisRequestedEvent = {
  owner: 'org',
  repo: 'repo',
  prNumber: 1,
  prTitle: 'Fix bug',
  commitSha: 'abc123',
  installationId: 42,
  repositoryId: 'repo-db-id',
};

function makeService() {
  return new AnalysisService(
    mockConfig as any,
    mockPrisma as any,
    mockGithub as any,
    mockRules as any,
    mockLlm as any,
    mockDiff as any,
    mockSharedFiles as any,
    mockScoring as any,
    mockEmitter as any,
  );
}

describe('AnalysisService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.scoringConfig.findFirst.mockResolvedValue({ high: 10, medium: 4, low: 1 });
    mockPrisma.analysis.findFirst.mockResolvedValue(null);
    mockGithub.getFileContent.mockResolvedValue(undefined);
  });

  describe('runPipeline', () => {
    it('should skip if analysis already exists (idempotency)', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue({ id: 'existing' });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockGithub.getPRContext).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should complete full pipeline and emit analysis.completed', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getPRContext.mockResolvedValue({ title: 'Fix bug', body: 'details' });
      mockGithub.getPRFiles.mockResolvedValue([
        {
          filename: 'src/app.ts',
          patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
          status: 'modified',
        },
      ]);
      mockRules.getActiveRulesForRepo.mockResolvedValue([
        { filename: 'src/app.ts', language: 'typescript', rules: [{ title: 'Security', description: 'Check', criticality: 'high' }] },
      ]);
      mockGithub.getFileContent.mockResolvedValue(`# Notes

## Automated Review Rules
- Controllers must not contain business logic.

## Other Section
- ignore me
`);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'src/app.ts',
          snippet: 'const secret = "hardcoded";',
          description: 'Hardcoded secret',
          reason: 'Exposes credentials',
          criticality: 'high',
          rule: 'Security',
        },
      ]);
      mockScoring.calculate.mockReturnValue(90);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'new-analysis-id', score: 90 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            repositoryId: 'repo-db-id',
            prNumber: 1,
            commitSha: 'abc123',
            score: 90,
            published: false,
          }),
        }),
      );

      expect(mockRules.getActiveRulesForRepo).toHaveBeenCalledWith('repo-db-id', [
        {
          filename: 'src/app.ts',
          patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
          status: 'modified',
        },
      ]);
      expect(mockSharedFiles.fetchSharedFilesContext).toHaveBeenCalledWith(
        'org',
        'repo',
        42,
        [
          {
            filename: 'src/app.ts',
            patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
            status: 'modified',
          },
        ],
      );
      expect(mockLlm.analyze).toHaveBeenCalledWith(
        'Fix bug',
        'details',
        [
          {
            filename: 'src/app.ts',
            patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
            status: 'modified',
          },
        ],
        '',
        [
          {
            filename: 'src/app.ts',
            language: 'typescript',
            rules: [{ title: 'Security', description: 'Check', criticality: 'high' }],
          },
        ],
        '## Automated Review Rules\n- Controllers must not contain business logic.',
      );
      expect(mockScoring.calculate).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            criticality: 'high',
            baselineStatus: 'new',
            advisory: false,
            issueKey: expect.any(String),
          }),
        ],
        { high: 10, medium: 4, low: 1 },
      );
      expect(mockGithub.getCompareFiles).not.toHaveBeenCalled();

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        ANALYSIS_COMPLETED,
        expect.objectContaining({ analysisId: 'new-analysis-id', prNumber: 1 }),
      );
    });

    it('should emit analysis.failed on pipeline error', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getPRContext.mockRejectedValue(new Error('GitHub API error'));

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        ANALYSIS_FAILED,
        expect.objectContaining({ prNumber: 1, error: expect.stringContaining('GitHub API error') }),
      );
    });

    it('should classify persistent, new, and known debt issues using the previous analysis baseline', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockPrisma.analysis.findFirst.mockResolvedValue({
        id: 'prev-analysis',
        commitSha: 'prev123',
        issues: [
          {
            file: 'src/app.ts',
            snippet: 'persist()',
            description: 'Persistent issue',
            reason: 'Existing root cause',
            criticality: 'high',
            rule: 'Security',
            issueKey: buildIssueKey({
              file: 'src/app.ts',
              description: 'Persistent issue',
              reason: 'Existing root cause',
              rule: 'Security',
            }),
            baselineStatus: 'persistent',
          },
          {
            file: 'src/legacy.ts',
            snippet: 'legacyProblem()',
            description: 'Legacy issue',
            reason: 'Pre-existing debt',
            criticality: 'medium',
            rule: 'Boas Práticas',
            issueKey: buildIssueKey({
              file: 'src/legacy.ts',
              description: 'Legacy issue',
              reason: 'Pre-existing debt',
              rule: 'Boas Práticas',
            }),
            baselineStatus: 'known_debt',
          },
        ],
      });
      mockGithub.getPRContext.mockResolvedValue({ title: 'Fix bug', body: 'details' });
      mockGithub.getPRFiles.mockResolvedValue([
        { filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+persist()', status: 'modified' },
        { filename: 'src/new.ts', patch: '@@ -1 +1 @@\n+introducedNow()', status: 'modified' },
        { filename: 'src/legacy.ts', patch: '@@ -1 +1 @@\n+legacyProblem()', status: 'modified' },
      ]);
      mockGithub.getCompareFiles.mockResolvedValue([
        { filename: 'src/new.ts', patch: '@@ -1 +1 @@\n+introducedNow()', status: 'modified' },
      ]);
      mockRules.getActiveRulesForRepo.mockResolvedValue([]);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'src/app.ts',
          snippet: 'persist()',
          description: 'Persistent issue',
          reason: 'Existing root cause',
          criticality: 'high',
          rule: 'Security',
        },
        {
          file: 'src/new.ts',
          snippet: 'introducedNow()',
          description: 'New issue',
          reason: 'Introduced in this commit',
          criticality: 'medium',
          rule: 'Security',
        },
        {
          file: 'src/legacy.ts',
          snippet: 'legacyProblem()',
          description: 'Legacy issue',
          reason: 'Pre-existing debt',
          criticality: 'medium',
          rule: 'Boas Práticas',
        },
      ]);
      mockScoring.calculate.mockReturnValue(86);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-with-baseline', score: 86 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockGithub.getCompareFiles).toHaveBeenCalledWith(
        'org',
        'repo',
        'prev123',
        'abc123',
        42,
      );
      expect(mockScoring.calculate).toHaveBeenCalledWith(
        [
          expect.objectContaining({ file: 'src/app.ts', baselineStatus: 'persistent', advisory: false }),
          expect.objectContaining({ file: 'src/new.ts', baselineStatus: 'new', advisory: false }),
        ],
        { high: 10, medium: 4, low: 1 },
      );
      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issues: expect.arrayContaining([
              expect.objectContaining({ file: 'src/app.ts', baselineStatus: 'persistent' }),
              expect.objectContaining({ file: 'src/new.ts', baselineStatus: 'new' }),
              expect.objectContaining({ file: 'src/legacy.ts', baselineStatus: 'known_debt' }),
            ]),
          }),
        }),
      );
    });

    it('should keep previously known debt outside the score when it reappears', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockPrisma.analysis.findFirst.mockResolvedValue({
        id: 'prev-analysis',
        commitSha: 'prev123',
        issues: [
          {
            file: 'src/legacy.ts',
            snippet: 'legacyProblem()',
            description: 'Legacy issue',
            reason: 'Pre-existing debt',
            criticality: 'medium',
            rule: 'Boas Práticas',
            issueKey: buildIssueKey({
              file: 'src/legacy.ts',
              description: 'Legacy issue',
              reason: 'Pre-existing debt',
              rule: 'Boas Práticas',
            }),
            baselineStatus: 'known_debt',
          },
        ],
      });
      mockGithub.getPRContext.mockResolvedValue({ title: 'Fix bug', body: 'details' });
      mockGithub.getPRFiles.mockResolvedValue([
        { filename: 'src/legacy.ts', patch: '@@ -1 +1 @@\n+legacyProblem()', status: 'modified' },
      ]);
      mockGithub.getCompareFiles.mockResolvedValue([]);
      mockRules.getActiveRulesForRepo.mockResolvedValue([]);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'src/legacy.ts',
          snippet: 'legacyProblem()',
          description: 'Legacy issue',
          reason: 'Pre-existing debt',
          criticality: 'medium',
          rule: 'Boas Práticas',
        },
      ]);
      mockScoring.calculate.mockReturnValue(100);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-known-debt', score: 100 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockScoring.calculate).toHaveBeenCalledWith([], { high: 10, medium: 4, low: 1 });
      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issues: [
              expect.objectContaining({
                file: 'src/legacy.ts',
                baselineStatus: 'known_debt',
                advisory: false,
              }),
            ],
          }),
        }),
      );
    });

    it('should use default scoring weights when no config exists', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(null);
      mockGithub.getPRContext.mockResolvedValue({ title: 'PR', body: '' });
      mockGithub.getPRFiles.mockResolvedValue([]);
      mockRules.getActiveRulesForRepo.mockResolvedValue([]);
      mockLlm.analyze.mockResolvedValue([]);
      mockScoring.calculate.mockReturnValue(100);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'x', score: 100 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockScoring.calculate).toHaveBeenCalledWith(
        [],
        { high: 10, medium: 4, low: 1 },
      );
    });
  });
});
