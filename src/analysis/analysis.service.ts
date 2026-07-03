import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService } from '../github/github.service';
import { RulesService } from '../rules/rules.service';
import { LlmService } from './llm.service';
import { DiffService } from './diff.service';
import { SharedFilesService } from './shared-files.service';
import { ScoringService } from './scoring.service';
import {
  ReviewCriticality,
  ReviewIssue,
  ReviewIssueBaselineStatus,
} from './review-issue.types';
import { buildIssueKey, issueMatchesDiff } from './review-issue.util';
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
    private readonly config: ConfigService,
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

      const [previousAnalysis, prContext, prFiles] = await Promise.all([
        this.findPreviousAnalysis(repositoryId, prNumber, commitSha),
        this.github.getPRContext(owner, repo, prNumber, installationId),
        this.github.getPRFiles(owner, repo, prNumber, installationId),
      ]);

      const activeRules = await this.rules.getActiveRulesForRepo(repositoryId, prFiles);

      const [sharedContext, agentContext] = await Promise.all([
        this.sharedFiles.fetchSharedFilesContext(owner, repo, installationId, prFiles),
        this.fetchAgentContext(owner, repo, installationId),
      ]);

      const rawIssues = await this.llm.analyze(
        prTitle,
        prContext.body,
        prFiles,
        sharedContext,
        activeRules,
        agentContext,
      );

      const compareFiles = previousAnalysis
        ? await this.github.getCompareFiles(
            owner,
            repo,
            previousAnalysis.commitSha,
            commitSha,
            installationId,
          )
        : prFiles;

      const issues = this.applyIssueCaps(
        this.applyBaseline(
          rawIssues,
          this.parseStoredIssues(previousAnalysis?.issues),
          compareFiles,
        ),
      );

      const weights = await this.getWeights();
      const score = this.scoring.calculate(this.getIssuesForScore(issues), weights);

      const analysis = await this.prisma.analysis.create({
        data: {
          repositoryId,
          prNumber,
          prTitle,
          commitSha,
          score,
          issues: this.serializeIssuesForStorage(issues),
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

  private async fetchAgentContext(
    owner: string,
    repo: string,
    installationId: number,
  ): Promise<string | undefined> {
    try {
      const content = await this.github.getFileContent(
        owner,
        repo,
        'AGENTS.md',
        installationId,
      );
      if (!content) return undefined;

      const marker = '## Automated Review Rules';
      const start = content.indexOf(marker);
      if (start === -1) return undefined;

      const nextSection = content.indexOf('\n## ', start + marker.length);
      return nextSection === -1
        ? content.slice(start).trim()
        : content.slice(start, nextSection).trim();
    } catch (err) {
      this.logger.warn(
        `Could not load AGENTS.md automated review rules for ${owner}/${repo}: ${String(err)}`,
      );
      return undefined;
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

  private getIssuesForScore(issues: ReviewIssue[]) {
    return issues.filter(
      (issue) => !issue.advisory && issue.baselineStatus !== 'known_debt',
    );
  }

  private async findPreviousAnalysis(
    repositoryId: string,
    prNumber: number,
    commitSha: string,
  ) {
    return this.prisma.analysis.findFirst({
      where: {
        repositoryId,
        prNumber,
        commitSha: { not: commitSha },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private parseStoredIssues(storedIssues: unknown): ReviewIssue[] {
    return Array.isArray(storedIssues) ? (storedIssues as ReviewIssue[]) : [];
  }

  private applyBaseline(
    currentIssues: ReviewIssue[],
    previousIssues: ReviewIssue[],
    compareFiles: Array<{ filename: string; patch: string; status: string }>,
  ): ReviewIssue[] {
    const previousIssueStatus = new Map<string, ReviewIssueBaselineStatus | undefined>();

    for (const issue of previousIssues) {
      const issueKey = issue.issueKey ?? buildIssueKey(issue);
      previousIssueStatus.set(issueKey, issue.baselineStatus);
    }

    return currentIssues.map((issue) => {
      const issueKey = issue.issueKey ?? buildIssueKey(issue);
      const hadPreviousIssue = previousIssueStatus.has(issueKey);
      const previousStatus = previousIssueStatus.get(issueKey);

      if (hadPreviousIssue) {
        return {
          ...issue,
          issueKey,
          baselineStatus:
            previousStatus === 'known_debt' ? 'known_debt' : 'persistent',
        };
      }

      return {
        ...issue,
        issueKey,
        baselineStatus: issueMatchesDiff(issue, compareFiles)
          ? 'new'
          : 'known_debt',
      };
    });
  }

  private applyIssueCaps(issues: ReviewIssue[]): ReviewIssue[] {
    const counts: Record<ReviewCriticality, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };
    const caps = this.getIssueCaps();

    return issues.map((issue) => {
      if (issue.baselineStatus === 'known_debt') {
        return {
          ...issue,
          advisory: false,
        };
      }

      const currentCount = counts[issue.criticality];
      const cap = caps[issue.criticality];

      if (currentCount < cap) {
        counts[issue.criticality] += 1;
        return {
          ...issue,
          advisory: false,
        };
      }

      return {
        ...issue,
        advisory: true,
      };
    });
  }

  private getIssueCaps(): Record<ReviewCriticality, number> {
    return {
      high: this.parseIssueCap(this.config.get<string>('ISSUE_CAP_HIGH'), 3),
      medium: this.parseIssueCap(this.config.get<string>('ISSUE_CAP_MEDIUM'), 5),
      low: this.parseIssueCap(this.config.get<string>('ISSUE_CAP_LOW'), 5),
    };
  }

  private parseIssueCap(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return fallback;
    }
    return parsed;
  }

  private serializeIssuesForStorage(issues: ReviewIssue[]): Prisma.InputJsonValue {
    const serializedIssues: Prisma.InputJsonObject[] = issues.map((issue) => {
      return {
        file: issue.file,
        snippet: issue.snippet,
        description: issue.description,
        reason: issue.reason,
        criticality: issue.criticality,
        rule: issue.rule,
        ...(issue.issueKey !== undefined ? { issueKey: issue.issueKey } : {}),
        ...(issue.baselineStatus !== undefined
          ? { baselineStatus: issue.baselineStatus }
          : {}),
        ...(issue.advisory !== undefined ? { advisory: issue.advisory } : {}),
      } satisfies Prisma.InputJsonObject;
    });

    return serializedIssues;
  }
}
