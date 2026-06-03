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

  async handlePullRequestEvent(eventType: string, body: any): Promise<void> {
    if (eventType !== 'pull_request') return;

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
