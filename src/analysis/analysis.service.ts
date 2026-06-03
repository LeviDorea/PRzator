import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService } from '../github/github.service';
import { RulesService } from '../rules/rules.service';
import { LlmService } from './llm.service';
import { DiffService } from './diff.service';
import { SharedFilesService } from './shared-files.service';
import { ScoringService } from './scoring.service';
import {
  ANALYSIS_COMPLETED,
  ANALYSIS_FAILED,
  AnalysisCompletedEvent,
  AnalysisFailedEvent,
  AnalysisRequestedEvent,
} from '../common/events/analysis.events';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubService,
    private readonly rules: RulesService,
    private readonly llm: LlmService,
    private readonly diff: DiffService,
    private readonly sharedFiles: SharedFilesService,
    private readonly scoring: ScoringService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async runPipeline(event: AnalysisRequestedEvent): Promise<void> {
    const {
      owner,
      repo,
      prNumber,
      prTitle,
      commitSha,
      installationId,
      repositoryId,
    } = event;

    try {
      const existing = await this.prisma.analysis.findUnique({
        where: {
          repositoryId_prNumber_commitSha: { repositoryId, prNumber, commitSha },
        },
      });
      if (existing) {
        this.logger.log(`Analysis already exists for ${owner}/${repo}#${prNumber}@${commitSha}`);
        return;
      }

      const [prContext, prFiles, activeRules] = await Promise.all([
        this.github.getPRContext(owner, repo, prNumber, installationId),
        this.github.getPRFiles(owner, repo, prNumber, installationId),
        this.rules.getActiveRulesForRepo(repositoryId),
      ]);

      const languages = await this.github.getRepoLanguages(owner, repo, installationId);
      const primaryLanguage = Object.keys(languages)[0] ?? 'TypeScript';

      const sharedContext = await this.sharedFiles.fetchSharedFilesContext(
        owner,
        repo,
        installationId,
        prFiles,
        primaryLanguage,
      );

      const issues = await this.llm.analyze(
        prTitle,
        prContext.body,
        prFiles,
        sharedContext,
        activeRules,
      );

      const weights = await this.getWeights();
      const score = this.scoring.calculate(issues, weights);

      const analysis = await this.prisma.analysis.create({
        data: {
          repositoryId,
          prNumber,
          prTitle,
          commitSha,
          score,
          issues,
          published: false,
        },
      });

      this.logger.log(`Analysis created: id=${analysis.id}, score=${score}`);

      const completedEvent: AnalysisCompletedEvent = {
        analysisId: analysis.id,
        owner,
        repo,
        prNumber,
        installationId,
      };
      this.eventEmitter.emit(ANALYSIS_COMPLETED, completedEvent);
    } catch (err) {
      this.logger.error(`Analysis pipeline failed for ${owner}/${repo}#${prNumber}`, {
        error: String(err),
      });

      const failedEvent: AnalysisFailedEvent = {
        owner,
        repo,
        prNumber,
        installationId,
        error: String(err),
      };
      this.eventEmitter.emit(ANALYSIS_FAILED, failedEvent);
    }
  }

  async findByRepository(repositoryId: string) {
    return this.prisma.analysis.findMany({
      where: { repositoryId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll() {
    return this.prisma.analysis.findMany({ orderBy: { createdAt: 'desc' } });
  }

  private async getWeights() {
    const config = await this.prisma.scoringConfig.findFirst();
    return {
      high: config?.high ?? 10,
      medium: config?.medium ?? 4,
      low: config?.low ?? 1,
    };
  }
}
