import { ConflictException, NotFoundException } from '@nestjs/common';
import { RepositoriesService } from './repositories.service';

const mockPrisma = {
  repository: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
};

const mockGithub = {
  getOrgInstallationId: jest.fn().mockResolvedValue(42),
  listOrgRepositories: jest.fn(),
  registerWebhook: jest.fn(),
  removeWebhook: jest.fn(),
};

function makeService() {
  return new RepositoriesService(mockPrisma as any, mockGithub as any);
}

describe('RepositoriesService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('should register webhook and persist repository', async () => {
      mockPrisma.repository.findUnique.mockResolvedValue(null);
      mockGithub.registerWebhook.mockResolvedValue(777);
      mockPrisma.repository.create.mockResolvedValue({ id: '1', webhookId: 777 });

      const svc = makeService();
      const dto = { owner: 'org', name: 'repo', fullName: 'org/repo', githubId: 1, installationId: 10 };
      const result = await svc.create(dto);

      expect(mockGithub.registerWebhook).toHaveBeenCalledWith('org', 'repo', 10);
      expect(mockPrisma.repository.create).toHaveBeenCalledWith({
        data: { ...dto, webhookId: 777 },
      });
      expect(result).toMatchObject({ webhookId: 777 });
    });

    it('should throw ConflictException if repository already exists', async () => {
      mockPrisma.repository.findUnique.mockResolvedValue({ id: 'existing' });

      const svc = makeService();
      await expect(
        svc.create({ owner: 'o', name: 'r', fullName: 'o/r', githubId: 1, installationId: 1 }),
      ).rejects.toThrow(ConflictException);

      expect(mockGithub.registerWebhook).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove webhook and delete repository', async () => {
      const repo = { id: '1', owner: 'org', name: 'repo', installationId: 10, webhookId: 555 };
      mockPrisma.repository.findUnique.mockResolvedValue(repo);
      mockGithub.removeWebhook.mockResolvedValue(undefined);
      mockPrisma.repository.delete.mockResolvedValue(repo);

      const svc = makeService();
      await svc.remove('1');

      expect(mockGithub.removeWebhook).toHaveBeenCalledWith('org', 'repo', 10, 555);
      expect(mockPrisma.repository.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    });

    it('should throw NotFoundException if repository does not exist', async () => {
      mockPrisma.repository.findUnique.mockResolvedValue(null);

      const svc = makeService();
      await expect(svc.remove('bad-id')).rejects.toThrow(NotFoundException);
    });

    it('should skip removeWebhook if webhookId is null', async () => {
      const repo = { id: '1', owner: 'org', name: 'repo', installationId: 10, webhookId: null };
      mockPrisma.repository.findUnique.mockResolvedValue(repo);
      mockPrisma.repository.delete.mockResolvedValue(repo);

      const svc = makeService();
      await svc.remove('1');

      expect(mockGithub.removeWebhook).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('should return list from prisma', async () => {
      mockPrisma.repository.findMany.mockResolvedValue([{ id: '1' }]);
      const svc = makeService();
      const result = await svc.findAll();
      expect(result).toEqual([{ id: '1' }]);
    });
  });
});
