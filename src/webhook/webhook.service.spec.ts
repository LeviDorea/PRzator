import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import * as crypto from 'crypto';

const SECRET = 'test-secret';

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

const mockConfig = {
  get: (key: string) => (key === 'GITHUB_WEBHOOK_SECRET' ? SECRET : ''),
};

const mockPrisma = {
  repository: {
    findUnique: jest.fn(),
  },
};

const mockEmitter = {
  emit: jest.fn(),
};

function makeService() {
  return new WebhookService(mockConfig as any, mockPrisma as any, mockEmitter as any);
}

describe('WebhookService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('validateSignature', () => {
    it('should not throw for valid signature', () => {
      const body = Buffer.from('{"hello":"world"}');
      const sig = sign(body.toString());
      const svc = makeService();
      expect(() => svc.validateSignature(body, sig)).not.toThrow();
    });

    it('should throw UnauthorizedException for invalid signature', () => {
      const body = Buffer.from('{"hello":"world"}');
      const svc = makeService();
      expect(() => svc.validateSignature(body, 'sha256=invalid')).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for missing signature', () => {
      const body = Buffer.from('{}');
      const svc = makeService();
      expect(() => svc.validateSignature(body, '')).toThrow(UnauthorizedException);
    });
  });

  describe('handleEvent (pull_request)', () => {
    const baseBody = {
      action: 'opened',
      number: 42,
      pull_request: {
        title: 'Fix bug',
        body: 'PR description',
        head: { sha: 'abc123' },
        base: { sha: 'base456' },
      },
      repository: { full_name: 'org/repo', owner: { login: 'org' }, name: 'repo' },
      installation: { id: 99 },
    };

    it('should emit analysis.requested for opened PR from registered repo', async () => {
      mockPrisma.repository.findUnique.mockResolvedValue({
        id: 'repo-db-id',
        installationId: 99,
      });
      const svc = makeService();
      await svc.handleEvent('pull_request', baseBody);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        'analysis.requested',
        expect.objectContaining({
          prNumber: 42,
          prBody: 'PR description',
          baseSha: 'base456',
          commitSha: 'abc123',
          repositoryId: 'repo-db-id',
        }),
      );
    });

    it('should do nothing for non pull_request events', async () => {
      const svc = makeService();
      await svc.handleEvent('push', {});
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should do nothing for unsupported PR actions', async () => {
      const svc = makeService();
      await svc.handleEvent('pull_request', { ...baseBody, action: 'closed' });
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for unregistered repository', async () => {
      mockPrisma.repository.findUnique.mockResolvedValue(null);
      const svc = makeService();
      await expect(
        svc.handleEvent('pull_request', baseBody),
      ).rejects.toThrow(NotFoundException);
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
