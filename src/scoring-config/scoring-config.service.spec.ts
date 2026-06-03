import { NotFoundException } from '@nestjs/common';
import { ScoringConfigService } from './scoring-config.service';

const mockConfig = { id: 'cfg-1', high: 10, medium: 4, low: 1 };

const mockPrisma = {
  scoringConfig: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
};

function makeService() {
  return new ScoringConfigService(mockPrisma as any);
}

describe('ScoringConfigService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('findOne', () => {
    it('should return the scoring config', async () => {
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(mockConfig);
      const svc = makeService();
      const result = await svc.findOne();
      expect(result).toEqual(mockConfig);
    });

    it('should throw NotFoundException when no config exists', async () => {
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(null);
      const svc = makeService();
      await expect(svc.findOne()).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update and return the config', async () => {
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(mockConfig);
      const updated = { ...mockConfig, high: 20 };
      mockPrisma.scoringConfig.update.mockResolvedValue(updated);

      const svc = makeService();
      const result = await svc.update({ high: 20, medium: 4, low: 1 });

      expect(mockPrisma.scoringConfig.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { high: 20, medium: 4, low: 1 },
      });
      expect(result.high).toBe(20);
    });

    it('should throw NotFoundException when no config to update', async () => {
      mockPrisma.scoringConfig.findFirst.mockResolvedValue(null);
      const svc = makeService();
      await expect(svc.update({ high: 5, medium: 2, low: 1 })).rejects.toThrow(NotFoundException);
    });
  });
});
