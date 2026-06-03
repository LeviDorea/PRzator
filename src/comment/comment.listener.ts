import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService } from '../github/github.service';
import { CommentService } from './comment.service';
import {
  ANALYSIS_COMPLETED,
  ANALYSIS_FAILED,
} from '../common/events/analysis.events';
import type {
  AnalysisCompletedEvent,
  AnalysisFailedEvent,
} from '../common/events/analysis.events';

@Injectable()
export class CommentListener {
  private readonly logger = new Logger(CommentListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly commentService: CommentService,
  ) {}

  @OnEvent(ANALYSIS_COMPLETED, { async: true })
  async handleCompleted(event: AnalysisCompletedEvent): Promise<void> {
    const { analysisId, owner, repo, prNumber, installationId } = event;

    const analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
    });

    if (!analysis) {
      this.logger.warn(`Analysis ${analysisId} not found for comment publishing`);
      return;
    }

    const body = this.commentService.formatMarkdown({
      score: analysis.score,
      prTitle: analysis.prTitle,
      issues: analysis.issues as any[],
    });

    await this.github.publishComment(owner, repo, prNumber, installationId, body);

    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: { published: true },
    });

    this.logger.log(`Comment published for PR #${prNumber} on ${owner}/${repo}`);
  }

  @OnEvent(ANALYSIS_FAILED, { async: true })
  async handleFailed(event: AnalysisFailedEvent): Promise<void> {
    const { owner, repo, prNumber, installationId, error } = event;

    const body = this.commentService.formatFailureComment(prNumber, error);

    try {
      await this.github.publishComment(owner, repo, prNumber, installationId, body);
    } catch (e) {
      this.logger.error(`Failed to publish failure comment for PR #${prNumber}`, {
        error: String(e),
      });
    }
  }
}
