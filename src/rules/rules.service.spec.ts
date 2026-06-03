import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RulesService } from './rules.service';

const DEFAULT_RULE = { id: 'default-1', title: 'Security', isDefault: true };
const CUSTOM_RULE = { id: 'custom-1', title: 'Custom', isDefault: false };

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
    it('should return default + global custom + repo-specific rules', async () => {
      const defaultRules = [{ id: 'd1', isDefault: true }];
      const globalCustom = [{ id: 'g1', isDefault: false }];
      const repoSpecific = [{ id: 'r1', isDefault: false }];

      mockPrisma.rule.findMany
        .mockResolvedValueOnce(defaultRules)
        .mockResolvedValueOnce(globalCustom)
        .mockResolvedValueOnce(repoSpecific);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-x');

      expect(result).toHaveLength(3);
      expect(result).toEqual([...defaultRules, ...globalCustom, ...repoSpecific]);
    });

    it('should not include custom rules associated to a different repo', async () => {
      mockPrisma.rule.findMany
        .mockResolvedValueOnce([DEFAULT_RULE])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const svc = makeService();
      const result = await svc.getActiveRulesForRepo('repo-y');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('default-1');
    });
  });
});
