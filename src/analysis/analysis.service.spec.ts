import { AnalysisService } from './analysis.service';
import type { AnalysisRequestedEvent } from '../common/events/analysis.events';
import { ANALYSIS_COMPLETED, ANALYSIS_FAILED } from '../common/events/analysis.events';

const mockPrisma = {
  analysis: {
    findUnique: jest.fn(),
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
  getRepoLanguages: jest.fn(),
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
      mockGithub.getPRFiles.mockResolvedValue([]);
      mockGithub.getRepoLanguages.mockResolvedValue({ TypeScript: 1000 });
      mockRules.getActiveRulesForRepo.mockResolvedValue([{ title: 'Security', criticality: 'high' }]);
      mockLlm.analyze.mockResolvedValue([{ criticality: 'high' }]);
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

    it('should use default scoring weights when no config exists', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(null);
      mockGithub.getPRContext.mockResolvedValue({ title: 'PR', body: '' });
      mockGithub.getPRFiles.mockResolvedValue([]);
      mockGithub.getRepoLanguages.mockResolvedValue({});
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
