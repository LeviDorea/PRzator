import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANALYSIS_REQUESTED,
  AnalysisRequestedEvent,
} from '../common/events/analysis.events';
import * as crypto from 'crypto';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  validateSignature(rawBody: Buffer, signature: string): void {
    if (!signature || !rawBody) {
      throw new UnauthorizedException('Missing webhook signature');
    }

    const secret = this.config.get<string>('GITHUB_WEBHOOK_SECRET') || '';
    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')}`;

    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);

    if (
      expectedBuf.length !== signatureBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, signatureBuf)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }

  async handleEvent(eventType: string, body: any): Promise<void> {
    switch (eventType) {
      case 'installation':
        await this.handleInstallationEvent(body);
        break;
      case 'installation_repositories':
        await this.handleInstallationRepositoriesEvent(body);
        break;
      case 'pull_request':
        await this.handlePullRequestEvent(body);
        break;
      default:
        break;
    }
  }

  private async handleInstallationEvent(body: any): Promise<void> {
    const { action, installation, repositories } = body;
    const installationId: number = installation?.id;
    const owner: string = installation?.account?.login;

    if (action === 'created' && Array.isArray(repositories)) {
      for (const r of repositories) {
        await this.upsertRepository(r, installationId, owner);
      }
      this.logger.log(`Installation created for ${owner}: registered ${repositories.length} repo(s)`);
    }

    if (action === 'deleted') {
      await this.prisma.repository.deleteMany({
        where: { installationId },
      });
      this.logger.log(`Installation deleted for ${owner}: removed repos with installationId ${installationId}`);
    }
  }

  private async handleInstallationRepositoriesEvent(body: any): Promise<void> {
    const { action, installation, repositories_added, repositories_removed } = body;
    const installationId: number = installation?.id;
    const owner: string = installation?.account?.login;

    if (action === 'added' && Array.isArray(repositories_added)) {
      for (const r of repositories_added) {
        await this.upsertRepository(r, installationId, owner);
      }
      this.logger.log(`Added ${repositories_added.length} repo(s) for installation ${installationId}`);
    }

    if (action === 'removed' && Array.isArray(repositories_removed)) {
      const fullNames = repositories_removed.map((r: any) => r.full_name);
      await this.prisma.repository.deleteMany({
        where: { fullName: { in: fullNames } },
      });
      this.logger.log(`Removed repos: ${fullNames.join(', ')}`);
    }
  }

  private async upsertRepository(r: any, installationId: number, owner: string): Promise<void> {
    const [, name] = (r.full_name as string).split('/');
    await this.prisma.repository.upsert({
      where: { fullName: r.full_name },
      update: { installationId },
      create: {
        githubId: r.id,
        owner,
        name,
        fullName: r.full_name,
        installationId,
      },
    });
  }

  private async handlePullRequestEvent(body: any): Promise<void> {
    const { action, number, pull_request, repository, installation } = body;

    if (!['opened', 'synchronize', 'reopened'].includes(action)) return;

    const fullName: string = repository?.full_name;
    if (!fullName) return;

    const repo = await this.prisma.repository.findUnique({
      where: { fullName },
    });

    if (!repo) {
      this.logger.warn(`Webhook received for unregistered repository: ${fullName}`);
      throw new NotFoundException(`Repository ${fullName} not registered`);
    }

    const event: AnalysisRequestedEvent = {
      owner: repository.owner.login,
      repo: repository.name,
      prNumber: number,
      prTitle: pull_request.title,
      commitSha: pull_request.head.sha,
      installationId: installation?.id ?? repo.installationId,
      repositoryId: repo.id,
    };

    this.logger.log(`Emitting analysis.requested for PR #${number} on ${fullName}`);
    this.eventEmitter.emit(ANALYSIS_REQUESTED, event);
  }
}
