import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RulesService } from './rules.service';

const DEFAULT_RULE = {
  id: 'default-1',
  title: 'Security',
  description: 'Check secrets',
  criticality: 'high',
  scope: 'file',
  fileGlobs: [],
  targetLanguage: null,
  whyThisRuleExists: null,
  localEvidence: [],
  isDefault: true,
};
const CUSTOM_RULE = {
  id: 'custom-1',
  title: 'Custom',
  description: 'Custom review rule',
  criticality: 'medium',
  scope: 'file',
  fileGlobs: [],
  targetLanguage: null,
  whyThisRuleExists: null,
  localEvidence: [],
  isDefault: false,
};

const mockPrisma = {
  rule: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  ruleRepository: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
};

function makeService() {
  return new RulesService(mockPrisma as any);
}

describe('RulesService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('update', () => {
    it('should throw ForbiddenException for default rules', async () => {
      mockPrisma.rule.findUnique.mockResolvedValue(DEFAULT_RULE);
      const svc = makeService();
      await expect(svc.update('default-1', { title: 'new' })).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.rule.update).not.toHaveBeenCalled();
    });

    it('should update custom rule', async () => {
      mockPrisma.rule.findUnique.mockResolvedValue(CUSTOM_RULE);
      mockPrisma.rule.update.mockResolvedValue({ ...CUSTOM_RULE, title: 'Updated' });
      const svc = makeService();
      const result = await svc.update('custom-1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('should throw NotFoundException for non-existent rule', async () => {
      mockPrisma.rule.findUnique.mockResolvedValue(null);
      const svc = makeService();
      await expect(svc.update('bad', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should throw ForbiddenException for default rules', async () => {
      mockPrisma.rule.findUnique.mockResolvedValue(DEFAULT_RULE);
      const svc = makeService();
      await expect(svc.remove('default-1')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.rule.delete).not.toHaveBeenCalled();
    });

    it('should delete custom rule', async () => {
      mockPrisma.rule.findUnique.mockResolvedValue(CUSTOM_RULE);
      mockPrisma.rule.delete.mockResolvedValue(CUSTOM_RULE);
      const svc = makeService();
      await svc.remove('custom-1');
      expect(mockPrisma.rule.delete).toHaveBeenCalledWith({ where: { id: 'custom-1' } });
    });
  });

  describe('associateToRepos', () => {
    it('should delete existing associations then create new ones', async () => {
      mockPrisma.rule.findUnique.mockResolvedValue(CUSTOM_RULE);
      mockPrisma.ruleRepository.deleteMany.mockResolvedValue({});
      mockPrisma.ruleRepository.createMany.mockResolvedValue({});
      mockPrisma.rule.findUnique.mockResolvedValue(CUSTOM_RULE);

      const svc = makeService();
      await svc.associateToRepos('custom-1', { repositoryIds: ['repo-a', 'repo-b'] });

      expect(mockPrisma.ruleRepository.deleteMany).toHaveBeenCalledWith({
        where: { ruleId: 'custom-1' },
      });
      expect(mockPrisma.ruleRepository.createMany).toHaveBeenCalledWith({
        data: [
          { ruleId: 'custom-1', repositoryId: 'repo-a' },
          { ruleId: 'custom-1', repositoryId: 'repo-b' },
        ],
        skipDuplicates: true,
      });
    });
  });

  describe('getActiveRulesForRepo', () => {
    it('should return applicable default + global custom + repo-specific rules per file', async () => {
      const defaultRules = [
        { ...DEFAULT_RULE, id: 'd1', title: 'All files' },
      ];
      const globalCustom = [
        {
          ...CUSTOM_RULE,
          id: 'g1',
          title: 'TypeScript only',
          fileGlobs: ['src/**/*.ts'],
          targetLanguage: 'TypeScript',
        },
      ];
      const repoSpecific = [
        {
          ...CUSTOM_RULE,
          id: 'r1',
          title: 'Python only',
          fileGlobs: ['scripts/**/*.py'],
          targetLanguage: 'python',
        },
      ];

      mockPrisma.rule.findMany
        .mockResolvedValueOnce(defaultRules)
        .mockResolvedValueOnce(globalCustom)
        .mockResolvedValueOnce(repoSpecific);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-x', [
        { filename: 'src/app/service.ts' },
        { filename: 'scripts/job/run.py' },
      ]);

      expect(result).toEqual({
        files: [
          {
            filename: 'src/app/service.ts',
            language: 'typescript',
            rules: [
              {
                title: 'All files',
                description: 'Check secrets',
                criticality: 'high',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
              {
                title: 'TypeScript only',
                description: 'Custom review rule',
                criticality: 'medium',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
            ],
          },
          {
            filename: 'scripts/job/run.py',
            language: 'python',
            rules: [
              {
                title: 'All files',
                description: 'Check secrets',
                criticality: 'high',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
              {
                title: 'Python only',
                description: 'Custom review rule',
                criticality: 'medium',
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
    });

    it('should drop default rules superseded by an active custom rule', async () => {
      const defaultRules = [
        { ...DEFAULT_RULE, id: 'd1', title: 'Magic Number Without Named Constant' },
        { ...DEFAULT_RULE, id: 'd2', title: 'SQL Injection Risk' },
      ];
      const repoSpecific = [
        {
          ...CUSTOM_RULE,
          id: 'r1',
          title: 'Reuse Domain Constants',
          supersedesDefaults: ['Magic Number Without Named Constant'],
        },
      ];

      mockPrisma.rule.findMany
        .mockResolvedValueOnce(defaultRules)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(repoSpecific);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-x', [
        { filename: 'src/app/service.ts' },
      ]);

      const titles = result.files[0].rules.map((rule) => rule.title);
      expect(titles).toEqual(['SQL Injection Risk', 'Reuse Domain Constants']);
    });

    it('should exclude rules whose glob or language does not match the file', async () => {
      mockPrisma.rule.findMany
        .mockResolvedValueOnce([DEFAULT_RULE])
        .mockResolvedValueOnce([
          {
            ...CUSTOM_RULE,
            id: 'glob-miss',
            title: 'Only test files',
            fileGlobs: ['**/*.spec.ts'],
            targetLanguage: 'typescript',
          },
        ])
        .mockResolvedValueOnce([
          {
            ...CUSTOM_RULE,
            id: 'lang-miss',
            title: 'Python architecture',
            fileGlobs: ['src/**/*.ts'],
            targetLanguage: 'python',
          },
        ]);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-y', [
        { filename: 'src/main.ts' },
      ]);

      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toEqual({
        filename: 'src/main.ts',
        language: 'typescript',
        rules: [
          {
            title: 'Security',
            description: 'Check secrets',
            criticality: 'high',
            scope: 'file',
            whyThisRuleExists: null,
            localEvidence: [],
          },
        ],
      });
      expect(result.prRules).toEqual([]);
      expect(result.contextPaths).toEqual([]);
    });

    it('should match php-prefixed CakePHP paths against app-based globs', async () => {
      mockPrisma.rule.findMany
        .mockResolvedValueOnce([
          {
            ...DEFAULT_RULE,
            id: 'cake-rule',
            title: 'Cake controller architecture',
            description: 'Business logic should stay out of controllers',
            fileGlobs: ['app/Controller/**/*.php'],
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-cake', [
        { filename: 'php/app/Controller/PedidosController.php' },
      ]);

      expect(result).toEqual({
        files: [
          {
            filename: 'php/app/Controller/PedidosController.php',
            language: 'php',
            rules: [
              {
                title: 'Cake controller architecture',
                description: 'Business logic should stay out of controllers',
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
    });

    it('should allow mixed and configuration rules when the file glob matches', async () => {
      mockPrisma.rule.findMany
        .mockResolvedValueOnce([
          {
            ...DEFAULT_RULE,
            id: 'mixed-rule',
            title: 'Mixed infra rule',
            description: 'Validate mixed language config files',
            fileGlobs: ['Dockerfile', 'app/**/*.py'],
            targetLanguage: 'mixed',
          },
          {
            ...DEFAULT_RULE,
            id: 'config-rule',
            title: 'Configuration contract',
            description: 'Validate config entrypoints',
            fileGlobs: ['next.config.ts', '.env.example'],
            targetLanguage: 'configuration',
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-config', [
        { filename: 'Dockerfile' },
        { filename: 'next.config.ts' },
        { filename: '.env.example' },
      ]);

      expect(result).toEqual({
        files: [
          {
            filename: 'Dockerfile',
            language: 'dockerfile',
            rules: [
              {
                title: 'Mixed infra rule',
                description: 'Validate mixed language config files',
                criticality: 'high',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
            ],
          },
          {
            filename: 'next.config.ts',
            language: 'typescript',
            rules: [
              {
                title: 'Configuration contract',
                description: 'Validate config entrypoints',
                criticality: 'high',
                scope: 'file',
                whyThisRuleExists: null,
                localEvidence: [],
              },
            ],
          },
          {
            filename: '.env.example',
            language: 'env',
            rules: [
              {
                title: 'Configuration contract',
                description: 'Validate config entrypoints',
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
    });

    it('should support brace-expanded file globs', async () => {
      mockPrisma.rule.findMany
        .mockResolvedValueOnce([
          {
            ...DEFAULT_RULE,
            id: 'brace-rule',
            title: 'TS or TSX',
            description: 'Matches both ts and tsx files',
            fileGlobs: ['app/**/*.{ts,tsx}'],
            targetLanguage: 'typescript',
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-braces', [
        { filename: 'app/page.tsx' },
      ]);

      expect(result).toEqual({
        files: [
          {
            filename: 'app/page.tsx',
            language: 'typescript',
            rules: [
              {
                title: 'TS or TSX',
                description: 'Matches both ts and tsx files',
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
    });

    it('should group PR-scoped rules once and expose their context files', async () => {
      mockPrisma.rule.findMany
        .mockResolvedValueOnce([
          {
            ...DEFAULT_RULE,
            id: 'pr-rule',
            title: 'Controller changes need tests',
            description: 'Behavior changes without updated tests must be flagged.',
            scope: 'pr',
            fileGlobs: ['php/app/Controller/**/*.php'],
            whyThisRuleExists: 'This repo expects controller changes to ship with tests.',
            localEvidence: [
              'AGENTS.md',
              'php/app/Test/Case/Controller/PedidosControllerTest.php',
            ],
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-pr', [
        { filename: 'php/app/Controller/PedidosController.php' },
        { filename: 'php/app/Test/Case/Controller/PedidosControllerTest.php' },
      ]);

      expect(result.files).toEqual([
        {
          filename: 'php/app/Controller/PedidosController.php',
          language: 'php',
          rules: [],
        },
        {
          filename: 'php/app/Test/Case/Controller/PedidosControllerTest.php',
          language: 'php',
          rules: [],
        },
      ]);
      expect(result.prRules).toEqual([
        {
          title: 'Controller changes need tests',
          description: 'Behavior changes without updated tests must be flagged.',
          criticality: 'high',
          scope: 'pr',
          whyThisRuleExists: 'This repo expects controller changes to ship with tests.',
          localEvidence: [
            'AGENTS.md',
            'php/app/Test/Case/Controller/PedidosControllerTest.php',
          ],
        },
      ]);
      expect(result.contextPaths).toEqual([
        'AGENTS.md',
        'php/app/Test/Case/Controller/PedidosControllerTest.php',
      ]);
    });
  });
});
