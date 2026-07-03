import { ConfigService } from '@nestjs/config';
import { GithubService } from './github.service';

const INSTALLATION_ID = 123;

function makeConfig(): ConfigService {
  return {
    get: (key: string) => {
      const map: Record<string, string> = {
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'placeholder',
        GITHUB_ORG: 'myorg',
        GITHUB_WEBHOOK_SECRET: 'secret',
        WEBHOOK_URL: 'https://myapp.com',
      };
      return map[key] ?? '';
    },
  } as unknown as ConfigService;
}

function buildService() {
  const svc = new GithubService(makeConfig());
  const mockRequest = jest.fn();
  const mockOctokit = { request: mockRequest };
  jest
    .spyOn(svc as any, 'getInstallationOctokit')
    .mockResolvedValue(mockOctokit);
  jest
    .spyOn(svc as any, 'getAppOctokit')
    .mockResolvedValue({ request: jest.fn() });
  return { svc, mockRequest, mockOctokit };
}

describe('GithubService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listOrgRepositories', () => {
    it('should return mapped repositories', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({
        data: {
          repositories: [
            { id: 1, name: 'repo1', owner: { login: 'org' }, full_name: 'org/repo1' },
            { id: 2, name: 'repo2', owner: { login: 'org' }, full_name: 'org/repo2' },
          ],
        },
      });

      const result = await svc.listOrgRepositories(INSTALLATION_ID);

      expect(result).toEqual([
        { id: 1, name: 'repo1', owner: 'org', fullName: 'org/repo1' },
        { id: 2, name: 'repo2', owner: 'org', fullName: 'org/repo2' },
      ]);
    });
  });

  describe('getPRContext', () => {
    it('should return title and body', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({ data: { title: 'My PR', body: 'Description' } });

      const result = await svc.getPRContext('org', 'repo', 1, INSTALLATION_ID);
      expect(result).toEqual({ title: 'My PR', body: 'Description' });
    });

    it('should return empty string for null body', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({ data: { title: 'PR', body: null } });

      const result = await svc.getPRContext('org', 'repo', 1, INSTALLATION_ID);
      expect(result.body).toBe('');
    });
  });

  describe('getPRFiles', () => {
    it('should return files with patch and status', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({
        data: [{ filename: 'src/app.ts', patch: '@@ -1 +1 @@ fix', status: 'modified' }],
      });

      const result = await svc.getPRFiles('org', 'repo', 1, INSTALLATION_ID);
      expect(result).toEqual([{ filename: 'src/app.ts', patch: '@@ -1 +1 @@ fix', status: 'modified' }]);
    });

    it('should return empty patch when file has no patch', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({ data: [{ filename: 'image.png', patch: undefined, status: 'added' }] });

      const result = await svc.getPRFiles('org', 'repo', 1, INSTALLATION_ID);
      expect(result[0].patch).toBe('');
    });
  });

  describe('getCompareFiles', () => {
    it('should return files from the compare endpoint with patch and status', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({
        data: {
          files: [{ filename: 'src/app.ts', patch: '@@ -1 +1 @@ fix', status: 'modified' }],
        },
      });

      const result = await svc.getCompareFiles('org', 'repo', 'base123', 'head456', INSTALLATION_ID);

      expect(result).toEqual([
        { filename: 'src/app.ts', patch: '@@ -1 +1 @@ fix', status: 'modified' },
      ]);
      expect(mockRequest).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/compare/{basehead}',
        expect.objectContaining({ basehead: 'base123...head456' }),
      );
    });
  });

  describe('getFileContent', () => {
    it('should decode base64 content', async () => {
      const { svc, mockRequest } = buildService();
      const encoded = Buffer.from('hello world').toString('base64');
      mockRequest.mockResolvedValue({ data: { content: encoded } });

      const result = await svc.getFileContent('org', 'repo', 'src/file.ts', INSTALLATION_ID);
      expect(result).toBe('hello world');
    });

    it('should return empty string if data is array', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({ data: [] });

      const result = await svc.getFileContent('org', 'repo', 'src/', INSTALLATION_ID);
      expect(result).toBe('');
    });
  });

  describe('getRepoLanguages', () => {
    it('should return language map', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({ data: { TypeScript: 12000, JavaScript: 3000 } });

      const result = await svc.getRepoLanguages('org', 'repo', INSTALLATION_ID);
      expect(result).toEqual({ TypeScript: 12000, JavaScript: 3000 });
    });
  });

  describe('registerWebhook', () => {
    it('should call POST /hooks with correct config and return webhook id', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({ data: { id: 999 } });

      const webhookId = await svc.registerWebhook('org', 'repo', INSTALLATION_ID);

      expect(webhookId).toBe(999);
      expect(mockRequest).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/hooks',
        expect.objectContaining({ owner: 'org', repo: 'repo', events: ['pull_request'] }),
      );
    });
  });

  describe('removeWebhook', () => {
    it('should call DELETE with correct hook_id', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({});

      await svc.removeWebhook('org', 'repo', INSTALLATION_ID, 999);

      expect(mockRequest).toHaveBeenCalledWith(
        'DELETE /repos/{owner}/{repo}/hooks/{hook_id}',
        expect.objectContaining({ hook_id: 999 }),
      );
    });
  });

  describe('publishComment', () => {
    it('should call POST /issues/:number/comments', async () => {
      const { svc, mockRequest } = buildService();
      mockRequest.mockResolvedValue({});

      await svc.publishComment('org', 'repo', 42, INSTALLATION_ID, 'body text');

      expect(mockRequest).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        expect.objectContaining({ issue_number: 42, body: 'body text' }),
      );
    });

    it('should not retry on 403 error', async () => {
      const { svc, mockRequest } = buildService();
      const err = Object.assign(new Error('Forbidden'), { status: 403 });
      mockRequest.mockRejectedValue(err);

      await expect(
        svc.publishComment('org', 'repo', 1, INSTALLATION_ID, 'body'),
      ).rejects.toThrow('Forbidden');
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });
});
