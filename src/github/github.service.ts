import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withRetry } from '../common/utils/retry.util';

@Injectable()
export class GithubService {
  private readonly logger = new Logger(GithubService.name);
  private readonly org: string;
  private readonly webhookBaseUrl: string;
  private readonly webhookSecret: string;
  private appInstance: any;

  constructor(private readonly config: ConfigService) {
    this.org = config.get<string>('GITHUB_ORG') || '';
    this.webhookBaseUrl = config.get<string>('WEBHOOK_URL') || '';
    this.webhookSecret = config.get<string>('GITHUB_WEBHOOK_SECRET') || '';
  }

  private async getApp(): Promise<any> {
    if (!this.appInstance) {
      const { App } = await import('@octokit/app');
      this.appInstance = new App({
        appId: this.config.get<string>('GITHUB_APP_ID') || '',
        privateKey: this.config.get<string>('GITHUB_APP_PRIVATE_KEY') || '',
      });
    }
    return this.appInstance;
  }

  protected async getInstallationOctokit(installationId: number): Promise<any> {
    const app = await this.getApp();
    return app.getInstallationOctokit(installationId);
  }

  protected async getAppOctokit(): Promise<any> {
    const app = await this.getApp();
    return app.octokit;
  }

  private shouldRetry(err: unknown): boolean {
    const status = (err as any)?.status ?? (err as any)?.response?.status;
    if (status === 401 || status === 403) return false;
    return true;
  }

  private get githubRetryOpts() {
    return {
      maxAttempts: 5,
      delays: [1000, 2000, 4000, 8000, 16000],
      retryOn: (err: unknown) => this.shouldRetry(err),
      onFinalFailure: async (err: unknown) => {
        this.logger.error('GitHub API call failed after all retries', { error: err });
      },
    };
  }

  async getOrgInstallationId(): Promise<number> {
    const octokit = await this.getAppOctokit();
    const { data } = await octokit.request(
      'GET /orgs/{org}/installation',
      { org: this.org },
    );
    return data.id;
  }

  async listOrgRepositories(
    installationId: number,
  ): Promise<Array<{ id: number; name: string; owner: string; fullName: string }>> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () => (octokit as any).request('GET /installation/repositories', { per_page: 100 }),
      this.githubRetryOpts,
    );
    return (data.repositories as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.owner.login,
      fullName: r.full_name,
    }));
  }

  async registerWebhook(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<number> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () =>
        (octokit as any).request('POST /repos/{owner}/{repo}/hooks', {
          owner,
          repo,
          name: 'web',
          active: true,
          events: ['pull_request'],
          config: {
            url: `${this.webhookBaseUrl}/webhook/github`,
            content_type: 'json',
            secret: this.webhookSecret,
          },
        }),
      this.githubRetryOpts,
    );
    return data.id;
  }

  async removeWebhook(
    owner: string,
    repo: string,
    installationId: number,
    webhookId: number,
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    await withRetry(
      () =>
        (octokit as any).request('DELETE /repos/{owner}/{repo}/hooks/{hook_id}', {
          owner,
          repo,
          hook_id: webhookId,
        }),
      this.githubRetryOpts,
    );
  }

  async getPRContext(
    owner: string,
    repo: string,
    prNumber: number,
    installationId: number,
  ): Promise<{ title: string; body: string }> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () =>
        (octokit as any).request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number: prNumber,
        }),
      this.githubRetryOpts,
    );
    return { title: data.title, body: data.body ?? '' };
  }

  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number,
    installationId: number,
  ): Promise<Array<{ filename: string; patch: string; status: string }>> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () =>
        (octokit as any).request(
          'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
          { owner, repo, pull_number: prNumber, per_page: 100 },
        ),
      this.githubRetryOpts,
    );
    return (data as any[]).map((f) => ({
      filename: f.filename,
      patch: f.patch ?? '',
      status: f.status,
    }));
  }

  async getCompareFiles(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    installationId: number,
  ): Promise<Array<{ filename: string; patch: string; status: string }>> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () =>
        (octokit as any).request(
          'GET /repos/{owner}/{repo}/compare/{basehead}',
          { owner, repo, basehead: `${baseSha}...${headSha}` },
        ),
      this.githubRetryOpts,
    );

    return ((data as any).files ?? []).map((f: any) => ({
      filename: f.filename,
      patch: f.patch ?? '',
      status: f.status,
    }));
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    installationId: number,
    ref?: string,
  ): Promise<string> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () =>
        (octokit as any).request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path,
          ...(ref ? { ref } : {}),
        }),
      this.githubRetryOpts,
    );
    if (Array.isArray(data)) return '';
    const content = (data as any).content ?? '';
    return Buffer.from(content, 'base64').toString('utf-8');
  }

  async getRepoLanguages(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<Record<string, number>> {
    const octokit = await this.getInstallationOctokit(installationId);
    const { data } = await withRetry<{ data: any }>(
      () =>
        (octokit as any).request('GET /repos/{owner}/{repo}/languages', {
          owner,
          repo,
        }),
      this.githubRetryOpts,
    );
    return data as Record<string, number>;
  }

  async publishComment(
    owner: string,
    repo: string,
    prNumber: number,
    installationId: number,
    body: string,
  ): Promise<void> {
    const octokit = await this.getInstallationOctokit(installationId);
    await withRetry(
      () =>
        (octokit as any).request(
          'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
          { owner, repo, issue_number: prNumber, body },
        ),
      {
        ...this.githubRetryOpts,
        onFinalFailure: async (err: unknown) => {
          this.logger.error('Failed to publish comment after all retries', {
            module: 'GithubService',
            action: 'publishComment',
            owner,
            repo,
            prNumber,
            error: String(err),
          });
        },
      },
    );
  }
}
