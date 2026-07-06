import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GithubService } from '../github/github.service';
import { RulesService } from '../rules/rules.service';
import { normalizePath } from '../common/utils/file-language.util';
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

const CAKE_FIXTURE_TEST_RULE_RE = /fixture-backed cake tests/i;
const MISSING_METHOD_DEFINITION_RE = /missing method definition|called but not defined/i;

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
      const compareFiles = previousAnalysis
        ? await this.github.getCompareFiles(
            owner,
            repo,
            previousAnalysis.commitSha,
            commitSha,
            installationId,
          )
        : prFiles;

      const [sharedContext, agentsMdContent] = await Promise.all([
        this.sharedFiles.fetchSharedFilesContext(
          owner,
          repo,
          installationId,
          prFiles,
          commitSha,
          activeRules.contextPaths,
        ),
        this.fetchAgentsMdContent(snapshot),
      ]);

      const rawIssues = await this.llm.analyze(
        prTitle,
        prBody,
        prFiles,
        sharedContext,
        activeRules.files,
        activeRules.prRules,
      );

      const verifiedIssues = await this.verifyIssuesAgainstCurrentFiles(snapshot, rawIssues);
      const nonSecretIssues = this.dropEnvVarSecretFalsePositives(verifiedIssues);
      const liveIssues = await this.dropCakeFixtureTestFalsePositives(
        snapshot,
        nonSecretIssues,
        prFiles,
      );

      const previousGeneralIssues = this.parseStoredGeneralIssues(
        previousAnalysis?.generalIssues,
      );
      const generalIssues = await this.dropVerifiedGeneralFalsePositives(
        snapshot,
        await this.runGeneralAnalysisSafely(
          prTitle,
          prBody,
          prFiles,
          agentsMdContent,
          previousGeneralIssues,
          compareFiles,
          owner,
          repo,
          prNumber,
        ),
      );

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
    compareFiles: Array<{ filename: string; patch: string; status: string }>,
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
        compareFiles,
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

  private async dropCakeFixtureTestFalsePositives(
    snapshot: AnalysisSnapshot,
    issues: ReviewIssue[],
    prFiles: Array<{ filename: string; patch: string; status: string }>,
  ): Promise<ReviewIssue[]> {
    const changedTestFiles = prFiles.filter((file) => this.isCakeTestFile(file.filename));
    if (changedTestFiles.length === 0) {
      return issues;
    }

    const contentCache = new Map<string, string>();
    const getContent = async (file: { filename: string; patch: string }) => {
      if (contentCache.has(file.filename)) {
        return contentCache.get(file.filename) ?? file.patch;
      }

      try {
        const content = await this.github.getFileContent(
          snapshot.owner,
          snapshot.repo,
          file.filename,
          snapshot.installationId,
          snapshot.headSha,
        );
        const resolvedContent = content || file.patch;
        contentCache.set(file.filename, resolvedContent);
        return resolvedContent;
      } catch (err) {
        this.logger.warn(
          `Could not fetch ${file.filename} to verify Cake test coverage; falling back to patch content: ${String(err)}`,
        );
        contentCache.set(file.filename, file.patch);
        return file.patch;
      }
    };

    const keptIssues: ReviewIssue[] = [];
    for (const issue of issues) {
      if (!CAKE_FIXTURE_TEST_RULE_RE.test(issue.rule)) {
        keptIssues.push(issue);
        continue;
      }

      const expectedTestPath = this.resolveExpectedCakeTestPath(issue.file);
      if (!expectedTestPath) {
        keptIssues.push(issue);
        continue;
      }

      const matchingTestFile = changedTestFiles.find(
        (file) => normalizePath(file.filename) === normalizePath(expectedTestPath),
      );
      if (!matchingTestFile) {
        keptIssues.push(issue);
        continue;
      }

      const evidenceTokens = this.extractCakeCoverageEvidenceTokens(issue);
      if (evidenceTokens.length === 0) {
        keptIssues.push(issue);
        continue;
      }

      const testContent = await getContent(matchingTestFile);
      if (this.contentContainsAnyEvidenceToken(testContent, evidenceTokens)) {
        this.logger.log(
          `Dropping Cake fixture-test false positive for ${issue.file}: changed test ${matchingTestFile.filename} references ${evidenceTokens[0]}`,
        );
        continue;
      }

      keptIssues.push(issue);
    }

    return keptIssues;
  }

  private async dropVerifiedGeneralFalsePositives(
    snapshot: AnalysisSnapshot,
    issues: GeneralIssue[],
  ): Promise<GeneralIssue[]> {
    const contentCache = new Map<string, string | null>();

    const getContent = async (path: string): Promise<string | null> => {
      if (contentCache.has(path)) {
        return contentCache.get(path) ?? null;
      }

      try {
        const content = await this.github.getFileContent(
          snapshot.owner,
          snapshot.repo,
          path,
          snapshot.installationId,
          snapshot.headSha,
        );
        contentCache.set(path, content);
        return content;
      } catch (err) {
        this.logger.warn(
          `Could not fetch ${path} to verify general issue; keeping it by default: ${String(err)}`,
        );
        contentCache.set(path, null);
        return null;
      }
    };

    const keptIssues: GeneralIssue[] = [];
    for (const issue of issues) {
      const methodLookup = this.resolveMissingMethodDefinitionLookup(issue);
      if (!methodLookup) {
        keptIssues.push(issue);
        continue;
      }

      const content = await getContent(methodLookup.file);
      if (content && this.fileDefinesMethod(content, methodLookup.methodName)) {
        this.logger.log(
          `Dropping missing-method false positive in ${issue.file}: ${methodLookup.methodName} exists in ${methodLookup.file}`,
        );
        continue;
      }

      keptIssues.push(issue);
    }

    return keptIssues;
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

  private isCakeTestFile(filename: string): boolean {
    return /\/Test\/Case\/.+Test\.php$/i.test(normalizePath(filename));
  }

  private resolveExpectedCakeTestPath(sourceFile: string): string | null {
    const normalized = normalizePath(sourceFile);
    const controllerMatch = normalized.match(/^((?:.*\/)?app\/)Controller\/([^/]+)\.php$/);
    if (controllerMatch) {
      return `${controllerMatch[1]}Test/Case/Controller/${controllerMatch[2]}Test.php`;
    }

    const modelMatch = normalized.match(/^((?:.*\/)?app\/)Model\/([^/]+)\.php$/);
    if (modelMatch) {
      return `${modelMatch[1]}Test/Case/Model/${modelMatch[2]}Test.php`;
    }

    return null;
  }

  private extractCakeCoverageEvidenceTokens(issue: ReviewIssue): string[] {
    const methodMatch = issue.snippet.match(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (methodMatch) {
      return this.expandSearchTokenVariants(methodMatch[1]);
    }

    const basename = normalizePath(issue.file).split('/').pop()?.replace(/\.php$/i, '');
    return basename ? this.expandSearchTokenVariants(basename) : [];
  }

  private expandSearchTokenVariants(token: string): string[] {
    const trimmed = token.trim();
    if (!trimmed) {
      return [];
    }

    const words = trimmed
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean);

    return Array.from(
      new Set(
        [
          trimmed.toLowerCase(),
          words.join(''),
          words.join('-'),
          words.join('_'),
          words.join(' '),
        ].filter(Boolean),
      ),
    );
  }

  private contentContainsAnyEvidenceToken(content: string, tokens: string[]): boolean {
    const lowerContent = content.toLowerCase();
    const squashedContent = lowerContent.replace(/[^a-z0-9]+/g, '');

    return tokens.some((token) => {
      const squashedToken = token.replace(/[^a-z0-9]+/g, '');
      return lowerContent.includes(token) || (!!squashedToken && squashedContent.includes(squashedToken));
    });
  }

  private resolveMissingMethodDefinitionLookup(
    issue: GeneralIssue,
  ): { file: string; methodName: string } | null {
    if (
      !MISSING_METHOD_DEFINITION_RE.test(issue.reason)
      && !MISSING_METHOD_DEFINITION_RE.test(issue.description)
    ) {
      return null;
    }

    const explicitModelCall = issue.snippet.match(
      /\$this->([A-Z][A-Za-z0-9_]*)->([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    if (explicitModelCall) {
      const appRoot = this.extractCakeAppRoot(issue.file);
      if (!appRoot) {
        return null;
      }

      return {
        file: `${appRoot}Model/${explicitModelCall[1]}.php`,
        methodName: explicitModelCall[2],
      };
    }

    const selfCall = issue.snippet.match(/\$this->([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (selfCall) {
      return {
        file: issue.file,
        methodName: selfCall[1],
      };
    }

    return null;
  }

  private extractCakeAppRoot(file: string): string | null {
    const match = normalizePath(file).match(
      /^((?:.*\/)?app\/)(?:Controller|Model|View|Test)\//,
    );
    return match?.[1] ?? null;
  }

  private fileDefinesMethod(content: string, methodName: string): boolean {
    const escapedMethodName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\bfunction\\s+${escapedMethodName}\\s*\\(`).test(content);
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
