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
  getCompareFiles: jest.fn(),
  getFileContent: jest.fn(),
  addPrReaction: jest.fn().mockResolvedValue(undefined),
};

const mockRules = {
  getActiveRulesForRepo: jest.fn(),
};

const mockLlm = {
  analyze: jest.fn(),
  analyzeGeneral: jest.fn().mockResolvedValue([]),
  critiqueIssues: jest.fn().mockResolvedValue(new Set()),
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

const EMPTY_ACTIVE_RULES = {
  files: [],
  prRules: [],
  contextPaths: [],
};

const EVENT: AnalysisRequestedEvent = {
  owner: 'org',
  repo: 'repo',
  prNumber: 1,
  prTitle: 'Fix bug',
  prBody: 'details',
  baseSha: 'base456',
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

      expect(mockGithub.getCompareFiles).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should complete full pipeline and emit analysis.completed', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'src/app.ts',
          patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
          status: 'modified',
        },
      ]);
      mockRules.getActiveRulesForRepo.mockResolvedValue({
        files: [
          {
            filename: 'src/app.ts',
            language: 'typescript',
            rules: [
              {
                title: 'Security',
                description: 'Check',
                criticality: 'high',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
            ],
          },
        ],
        prRules: [],
        contextPaths: [],
      });
      mockGithub.getFileContent.mockImplementation((_owner: string, _repo: string, path: string) => {
        if (path === 'AGENTS.md') {
          return Promise.resolve(`# Notes

Some repository conventions live here.
`);
        }
        if (path === 'src/app.ts') {
          return Promise.resolve('const secret = "hardcoded";');
        }
        return Promise.resolve(undefined);
      });
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

      expect(mockGithub.getCompareFiles).toHaveBeenCalledTimes(1);
      expect(mockGithub.getCompareFiles).toHaveBeenCalledWith('org', 'repo', 'base456', 'abc123', 42);

      const enrichedFiles = [
        {
          filename: 'src/app.ts',
          patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
          status: 'modified',
          fullContent: 'const secret = "hardcoded";',
        },
      ];
      expect(mockRules.getActiveRulesForRepo).toHaveBeenCalledWith(
        'repo-db-id',
        enrichedFiles,
      );
      expect(mockSharedFiles.fetchSharedFilesContext).toHaveBeenCalledWith(
        'org',
        'repo',
        42,
        enrichedFiles,
        'abc123',
        [],
      );
      expect(mockLlm.analyze).toHaveBeenCalledWith(
        'Fix bug',
        'details',
        enrichedFiles,
        '',
        [
          {
            filename: 'src/app.ts',
            language: 'typescript',
            rules: [
              {
                title: 'Security',
                description: 'Check',
                criticality: 'high',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
            ],
          },
        ],
        [],
      );
      expect(mockLlm.analyzeGeneral).toHaveBeenCalledWith(
        'Fix bug',
        'details',
        enrichedFiles,
        '# Notes\n\nSome repository conventions live here.',
        [],
        enrichedFiles,
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

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        ANALYSIS_COMPLETED,
        expect.objectContaining({ analysisId: 'new-analysis-id', prNumber: 1 }),
      );
    });

    it('should emit analysis.failed on pipeline error', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockRejectedValue(new Error('GitHub API error'));

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        ANALYSIS_FAILED,
        expect.objectContaining({ prNumber: 1, error: expect.stringContaining('GitHub API error') }),
      );
    });

    it('should classify persistent and new issues and drop pre-existing (out-of-diff) ones', async () => {
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
              rule: 'Security',
              snippet: 'persist()',
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
              rule: 'Boas Práticas',
              snippet: 'legacyProblem()',
            }),
            baselineStatus: 'known_debt',
          },
        ],
      });
      mockGithub.getCompareFiles.mockImplementation((_owner: string, _repo: string, base: string) => {
        if (base === 'prev123') {
          return Promise.resolve([
            { filename: 'src/new.ts', patch: '@@ -1 +1 @@\n+introducedNow()', status: 'modified' },
          ]);
        }
        return Promise.resolve([
          { filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+persist()', status: 'modified' },
          { filename: 'src/new.ts', patch: '@@ -1 +1 @@\n+introducedNow()', status: 'modified' },
          { filename: 'src/legacy.ts', patch: '@@ -1 +1 @@\n+legacyProblem()', status: 'modified' },
        ]);
      });
      mockGithub.getFileContent.mockImplementation((_owner: string, _repo: string, path: string) => {
        const contents: Record<string, string> = {
          'src/app.ts': 'persist()',
          'src/new.ts': 'introducedNow()',
          'src/legacy.ts': 'legacyProblem()',
        };
        return Promise.resolve(contents[path]);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
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
      const storedIssues = mockPrisma.analysis.create.mock.calls[0][0].data.issues;
      expect(storedIssues).toHaveLength(2);
      expect(storedIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: 'src/app.ts', baselineStatus: 'persistent' }),
          expect.objectContaining({ file: 'src/new.ts', baselineStatus: 'new' }),
        ]),
      );
      expect(storedIssues).not.toContainEqual(
        expect.objectContaining({ file: 'src/legacy.ts' }),
      );
    });

    it('should drop previously known debt entirely when it reappears (diff-only scope)', async () => {
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
              rule: 'Boas Práticas',
              snippet: 'legacyProblem()',
            }),
            baselineStatus: 'known_debt',
          },
        ],
      });
      mockGithub.getCompareFiles.mockImplementation((_owner: string, _repo: string, base: string) => {
        if (base === 'prev123') {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { filename: 'src/legacy.ts', patch: '@@ -1 +1 @@\n+legacyProblem()', status: 'modified' },
        ]);
      });
      mockGithub.getFileContent.mockImplementation((_owner: string, _repo: string, path: string) => {
        if (path === 'src/legacy.ts') {
          return Promise.resolve('legacyProblem()');
        }
        return Promise.resolve(undefined);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
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
      const storedIssues = mockPrisma.analysis.create.mock.calls[0][0].data.issues;
      expect(storedIssues).toEqual([]);
    });

    it('should complete the pipeline and keep the score even if general analysis fails', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'src/app.ts',
          patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_owner: string, _repo: string, path: string) => {
        if (path === 'src/app.ts') {
          return Promise.resolve('const secret = "hardcoded";');
        }
        return Promise.resolve(undefined);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
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
      mockLlm.analyzeGeneral.mockRejectedValue(
        new Error('429 Request too large for gpt-4o on tokens per min (TPM)'),
      );
      mockScoring.calculate.mockReturnValue(90);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'new-analysis-id', score: 90 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ score: 90, generalIssues: [] }),
        }),
      );
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        ANALYSIS_COMPLETED,
        expect.objectContaining({ analysisId: 'new-analysis-id' }),
      );
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        ANALYSIS_FAILED,
        expect.anything(),
      );
    });

    it('should drop Cake fixture-test issues when the matching changed tests reference the new behavior', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: '@@ -1 +1 @@\n+public function warRoom()',
          status: 'modified',
        },
        {
          filename: 'php/app/Model/Pedido.php',
          patch: '@@ -1 +1 @@\n+public function buildWarRoomSnapshot(array $filters = [], array $scenario = [])',
          status: 'modified',
        },
        {
          filename: 'php/app/Test/Case/Controller/PedidosControllerTest.php',
          patch: '@@ -1 +1 @@\n+public function testWarRoomSetsScenarioAndSnapshot()',
          status: 'modified',
        },
        {
          filename: 'php/app/Test/Case/Model/PedidoTest.php',
          patch: '@@ -1 +1 @@\n+public function testBuildWarRoomSnapshotReturnsRecoveryPlanAndMessages()',
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_owner: string, _repo: string, path: string) => {
        const contents: Record<string, string> = {
          'php/app/Controller/PedidosController.php':
            'public function warRoom()\n    {\n        // ...\n    }',
          'php/app/Model/Pedido.php':
            'public function buildWarRoomSnapshot(array $filters = [], array $scenario = [])\n    {\n        // ...\n    }',
          'php/app/Test/Case/Controller/PedidosControllerTest.php':
            "public function testWarRoomSetsScenarioAndSnapshot() { return $this->testAction('/pedidos/war-room'); }",
          'php/app/Test/Case/Model/PedidoTest.php':
            'public function testBuildWarRoomSnapshotReturnsRecoveryPlanAndMessages() { $this->Pedido->buildWarRoomSnapshot([], []); }',
        };
        return Promise.resolve(contents[path]);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'php/app/Controller/PedidosController.php',
          snippet: 'public function warRoom()\n    {\n        // ...\n    }',
          description: 'Missing fixture-backed controller coverage.',
          reason: 'warRoom introduced new behavior without matching ControllerTestCase coverage.',
          criticality: 'high',
          rule: 'Controller And Model Changes Need Fixture-Backed Cake Tests',
        },
        {
          file: 'php/app/Model/Pedido.php',
          snippet:
            'public function buildWarRoomSnapshot(array $filters = [], array $scenario = [])\n    {\n        // ...\n    }',
          description: 'Missing fixture-backed model coverage.',
          reason: 'buildWarRoomSnapshot introduced new behavior without matching CakeTestCase coverage.',
          criticality: 'high',
          rule: 'Controller And Model Changes Need Fixture-Backed Cake Tests',
        },
      ]);
      mockScoring.calculate.mockReturnValue(100);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-cake-fixtures', score: 100 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockScoring.calculate).toHaveBeenCalledWith([], { high: 10, medium: 4, low: 1 });
      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issues: [],
          }),
        }),
      );
    });

    it('should drop missing-method general issues when the target PHP method exists', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: '@@ -1 +1 @@\n+$filters = $this->Pedido->normalizeControlCenterFilters($this->request->query);',
          status: 'modified',
        },
        {
          filename: 'php/app/Model/Pedido.php',
          patch: '@@ -1 +1 @@\n+$orders = $this->findControlCenterOrders($filters, 200);',
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_owner: string, _repo: string, path: string) => {
        const contents: Record<string, string> = {
          'php/app/Model/Pedido.php':
            'public function normalizeControlCenterFilters(array $query) {}\npublic function findControlCenterOrders(array $filters = [], $limit = 20) {}',
        };
        return Promise.resolve(contents[path]);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
      mockLlm.analyze.mockResolvedValue([]);
      mockLlm.analyzeGeneral.mockResolvedValue([
        {
          file: 'php/app/Controller/PedidosController.php',
          snippet: '$filters = $this->Pedido->normalizeControlCenterFilters($this->request->query);',
          description:
            'The method `normalizeControlCenterFilters` is called but not defined in the `Pedido` model. This could lead to a fatal error if the method does not exist.',
          reason: 'Missing method definition',
          criticality: 'high',
          issueKey: 'general-1',
        },
        {
          file: 'php/app/Model/Pedido.php',
          snippet: '$orders = $this->findControlCenterOrders($filters, 200);',
          description:
            'The method `findControlCenterOrders` is called but not defined in the `Pedido` model. This could lead to a fatal error if the method does not exist.',
          reason: 'Missing method definition',
          criticality: 'high',
          issueKey: 'general-2',
        },
      ]);
      mockScoring.calculate.mockReturnValue(100);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-general-methods', score: 100 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            generalIssues: [],
          }),
        }),
      );
    });

    it('should keep issues whose evidence citation exists in the cited file', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: "@@ -1 +1 @@\n+$this->Pedido->find('all', ['conditions' => ['status' => 1]]);",
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_o: string, _r: string, path: string) => {
        const contents: Record<string, string> = {
          'php/app/Controller/PedidosController.php':
            "$this->Pedido->find('all', ['conditions' => ['status' => 1]]);",
          'php/app/Model/Pedido.php':
            'public function findActive() { return $this->find(\'all\', [\'conditions\' => [\'status\' => 1]]); }',
        };
        return Promise.resolve(contents[path]);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'php/app/Controller/PedidosController.php',
          snippet: "$this->Pedido->find('all', ['conditions' => ['status' => 1]]);",
          description: 'Query duplicates an existing model method.',
          reason: 'Pedido::findActive already runs this exact lookup.',
          criticality: 'medium',
          rule: 'Duplicated Database Query',
          evidence: {
            file: 'php/app/Model/Pedido.php',
            quote: 'public function findActive()',
          },
        },
      ]);
      mockScoring.calculate.mockReturnValue(96);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-evidence-ok', score: 96 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issues: [
              expect.objectContaining({
                rule: 'Duplicated Database Query',
                evidence: {
                  file: 'php/app/Model/Pedido.php',
                  quote: 'public function findActive()',
                },
              }),
            ],
          }),
        }),
      );
    });

    it('should drop issues whose evidence citation is not found in the cited file', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: "@@ -1 +1 @@\n+$this->Pedido->find('all', ['conditions' => ['status' => 1]]);",
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_o: string, _r: string, path: string) => {
        const contents: Record<string, string> = {
          'php/app/Controller/PedidosController.php':
            "$this->Pedido->find('all', ['conditions' => ['status' => 1]]);",
          'php/app/Model/Pedido.php': 'public function beforeSave($options = []) { return true; }',
        };
        return Promise.resolve(contents[path]);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'php/app/Controller/PedidosController.php',
          snippet: "$this->Pedido->find('all', ['conditions' => ['status' => 1]]);",
          description: 'Query duplicates an existing model method.',
          reason: 'Pedido::findActive already runs this exact lookup.',
          criticality: 'medium',
          rule: 'Duplicated Database Query',
          evidence: {
            file: 'php/app/Model/Pedido.php',
            quote: 'public function findActive()',
          },
        },
      ]);
      mockScoring.calculate.mockReturnValue(100);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-evidence-bad', score: 100 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockScoring.calculate).toHaveBeenCalledWith([], { high: 10, medium: 4, low: 1 });
      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issues: [],
          }),
        }),
      );
    });

    it('should drop issues refuted by the critic pass', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: '@@ -1 +1 @@\n+public function warRoom() {}',
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_o: string, _r: string, path: string) => {
        if (path === 'php/app/Controller/PedidosController.php') {
          return Promise.resolve("public $uses = ['Pedido'];\npublic function warRoom() {}");
        }
        return Promise.resolve(undefined);
      });
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
      mockLlm.analyze.mockResolvedValue([
        {
          file: 'php/app/Controller/PedidosController.php',
          snippet: 'public function warRoom() {}',
          description: 'Model used without $uses declaration.',
          reason: 'warRoom uses Pedido without declaring it.',
          criticality: 'medium',
          rule: 'Controllers Must Declare Accessed Models In $uses',
        },
      ]);
      mockLlm.critiqueIssues.mockImplementationOnce((issues: any[]) =>
        Promise.resolve(new Set([issues[0].issueKey])),
      );
      mockScoring.calculate.mockReturnValue(100);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-critic', score: 100 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockLlm.critiqueIssues).toHaveBeenCalledWith(
        [expect.objectContaining({ rule: 'Controllers Must Declare Accessed Models In $uses' })],
        [
          expect.objectContaining({
            path: 'php/app/Controller/PedidosController.php',
            content: expect.stringContaining("public $uses = ['Pedido'];"),
          }),
        ],
      );
      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issues: [] }),
        }),
      );
    });

    it('should keep all issues when the critic pass fails', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([
        {
          filename: 'src/app.ts',
          patch: '@@ -1 +1 @@\n+const secret = "hardcoded";',
          status: 'modified',
        },
      ]);
      mockGithub.getFileContent.mockImplementation((_o: string, _r: string, path: string) =>
        Promise.resolve(path === 'src/app.ts' ? 'const secret = "hardcoded";' : undefined),
      );
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
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
      mockLlm.critiqueIssues.mockRejectedValueOnce(new Error('critic unavailable'));
      mockScoring.calculate.mockReturnValue(90);
      mockPrisma.analysis.create.mockResolvedValue({ id: 'analysis-critic-fail', score: 90 });

      const svc = makeService();
      await svc.runPipeline(EVENT);

      expect(mockPrisma.analysis.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issues: [expect.objectContaining({ rule: 'Security' })],
          }),
        }),
      );
    });

    it('should use default scoring weights when no config exists', async () => {
      mockPrisma.analysis.findUnique.mockResolvedValue(null);
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(null);
      mockGithub.getCompareFiles.mockResolvedValue([]);
      mockRules.getActiveRulesForRepo.mockResolvedValue(EMPTY_ACTIVE_RULES);
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
