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
  GeneralIssue,
  ReviewCriticality,
  ReviewIssue,
  ReviewIssueBaselineStatus,
} from './review-issue.types';
import { AnalysisSnapshot } from './analysis-snapshot.types';
import {
  buildIssueKey,
  isEnvVarOnlySecretFinding,
  issueMatchesDiff,
  snippetExistsInContent,
} from './review-issue.util';
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
      prBody,
      baseSha,
      commitSha,
      installationId,
      repositoryId,
    } = event;

    const snapshot: AnalysisSnapshot = {
      owner,
      repo,
      installationId,
      baseSha,
      headSha: commitSha,
    };

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

      const [previousAnalysis, prFiles] = await Promise.all([
        this.findPreviousAnalysis(repositoryId, prNumber, commitSha),
        this.github.getCompareFiles(owner, repo, baseSha, commitSha, installationId),
      ]);

      const activeRules = await this.rules.getActiveRulesForRepo(repositoryId, prFiles);

      const [sharedContext, agentsMdContent] = await Promise.all([
        this.sharedFiles.fetchSharedFilesContext(owner, repo, installationId, prFiles, commitSha),
        this.fetchAgentsMdContent(snapshot),
      ]);

      const rawIssues = await this.llm.analyze(
        prTitle,
        prBody,
        prFiles,
        sharedContext,
        activeRules,
      );

      const verifiedIssues = await this.verifyIssuesAgainstCurrentFiles(snapshot, rawIssues);
      const liveIssues = this.dropEnvVarSecretFalsePositives(verifiedIssues);

      const previousGeneralIssues = this.parseStoredGeneralIssues(
        previousAnalysis?.generalIssues,
      );
      const generalIssues = await this.runGeneralAnalysisSafely(
        prTitle,
        prBody,
        prFiles,
        agentsMdContent,
        previousGeneralIssues,
        owner,
        repo,
        prNumber,
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
          liveIssues,
          this.parseStoredIssues(previousAnalysis?.issues),
          compareFiles,
        ),
      );

      const weights = await this.getWeights();
      const score = this.scoring.calculate(this.getIssuesForScore(issues), weights);

      let analysis;
      try {
        analysis = await this.prisma.analysis.create({
          data: {
            repositoryId,
            prNumber,
            prTitle,
            commitSha,
            score,
            issues: this.serializeIssuesForStorage(issues),
            generalIssues: this.serializeGeneralIssuesForStorage(generalIssues),
            published: false,
          },
        });
      } catch (createErr) {
        if (this.isDuplicateAnalysisError(createErr)) {
          this.logger.warn(
            `Concurrent analysis already persisted for ${owner}/${repo}#${prNumber}@${commitSha}; discarding this duplicate run.`,
          );
          return;
        }
        throw createErr;
      }

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

  private isDuplicateAnalysisError(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }

    const target = (err.meta as { target?: unknown })?.target;
    if (Array.isArray(target)) {
      return target.includes('commitSha');
    }
    if (typeof target === 'string') {
      return target.includes('commitSha');
    }
    return false;
  }

  private async runGeneralAnalysisSafely(
    prTitle: string,
    prBody: string,
    prFiles: Array<{ filename: string; patch: string; status: string }>,
    agentsMdContent: string | undefined,
    previousGeneralIssues: GeneralIssue[],
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<GeneralIssue[]> {
    try {
      return await this.llm.analyzeGeneral(
        prTitle,
        prBody,
        prFiles,
        agentsMdContent,
        previousGeneralIssues,
      );
    } catch (err) {
      this.logger.warn(
        `General-purpose analysis failed for ${owner}/${repo}#${prNumber}, keeping previous general issues unchanged: ${String(err)}`,
      );
      return previousGeneralIssues;
    }
  }

  private async fetchAgentsMdContent(
    snapshot: AnalysisSnapshot,
  ): Promise<string | undefined> {
    try {
      const content = await this.github.getFileContent(
        snapshot.owner,
        snapshot.repo,
        'AGENTS.md',
        snapshot.installationId,
        snapshot.headSha,
      );
      return content?.trim() || undefined;
    } catch (err) {
      this.logger.warn(`Could not load AGENTS.md for ${snapshot.owner}/${snapshot.repo}: ${String(err)}`);
      return undefined;
    }
  }

  private async verifyIssuesAgainstCurrentFiles(
    snapshot: AnalysisSnapshot,
    issues: ReviewIssue[],
  ): Promise<ReviewIssue[]> {
    const fileContentCache = new Map<string, string | null>();

    const getContent = async (file: string): Promise<string | null> => {
      if (fileContentCache.has(file)) {
        return fileContentCache.get(file) ?? null;
      }
      try {
        const content = await this.github.getFileContent(
          snapshot.owner,
          snapshot.repo,
          file,
          snapshot.installationId,
          snapshot.headSha,
        );
        fileContentCache.set(file, content);
        return content;
      } catch (err) {
        this.logger.warn(
          `Could not fetch ${file} at ${snapshot.headSha} to verify issue; keeping it by default: ${String(err)}`,
        );
        fileContentCache.set(file, null);
        return null;
      }
    };

    const verified: ReviewIssue[] = [];
    for (const issue of issues) {
      const content = await getContent(issue.file);
      if (content === null || snippetExistsInContent(issue.snippet, content)) {
        verified.push(issue);
        continue;
      }

      this.logger.log(
        `Dropping stale issue for rule "${issue.rule}" in ${issue.file}: snippet no longer present at ${snapshot.headSha}`,
      );
    }

    return verified;
  }

  /**
   * Deterministic guard for the "Secret Exposure" rule: the LLM keeps flagging
   * environment-variable references (e.g. `-p"${MYSQL_ROOT_PASSWORD}"`) as
   * hardcoded secrets despite the rule text. Drop those false positives, but
   * keep anything that still contains a plausible literal credential.
   */
  private dropEnvVarSecretFalsePositives(issues: ReviewIssue[]): ReviewIssue[] {
    return issues.filter((issue) => {
      const isSecretRule = /secret\s*exposure/i.test(issue.rule);
      if (isSecretRule && isEnvVarOnlySecretFinding(issue.snippet)) {
        this.logger.log(
          `Dropping Secret Exposure false positive in ${issue.file}: snippet is an env-var reference, not a hardcoded secret`,
        );
        return false;
      }
      return true;
    });
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

  private parseStoredGeneralIssues(storedIssues: unknown): GeneralIssue[] {
    return Array.isArray(storedIssues) ? (storedIssues as GeneralIssue[]) : [];
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

    return currentIssues
      .map((issue): ReviewIssue => {
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
      })
      // Review scope is the diff only: drop anything not introduced by this PR
      // (pre-existing violations flagged from surrounding context).
      .filter((issue) => issue.baselineStatus !== 'known_debt');
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

  private serializeGeneralIssuesForStorage(
    issues: GeneralIssue[],
  ): Prisma.InputJsonValue {
    const serializedIssues: Prisma.InputJsonObject[] = issues.map((issue) => ({
      file: issue.file,
      snippet: issue.snippet,
      description: issue.description,
      reason: issue.reason,
      criticality: issue.criticality,
      issueKey: issue.issueKey,
    }));

    return serializedIssues;
  }
}
