import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { withRetry } from '../common/utils/retry.util';
import { DiffFile, DiffService } from './diff.service';
import { FileRulesContext, RulePromptContext } from '../rules/rules.service';
import { GeneralIssue, ReviewIssue } from './review-issue.types';
import { buildIssueKey, buildGeneralIssueKey, issueMatchesDiff } from './review-issue.util';

const IssueSchema = z.object({
  file: z.string(),
  snippet: z.string(),
  description: z
    .string()
    .describe(
      'What the problem is, in general terms (can restate the rule in your own words).',
    ),
  reason: z
    .string()
    .describe(
      'Why THIS specific occurrence violates the rule, referencing the actual code in the snippet. ' +
        'Must not just repeat the rule title or description.',
    ),
  criticality: z.enum(['low', 'medium', 'high']),
  rule: z.string(),
});

const LlmOutputSchema = z.object({
  issues: z.array(IssueSchema),
});

const GeneralIssueSchema = z.object({
  file: z.string(),
  snippet: z.string(),
  description: z.string(),
  reason: z.string(),
  criticality: z.enum(['low', 'medium', 'high']),
});

const GeneralDiscoveryOutputSchema = z.object({
  issues: z.array(GeneralIssueSchema),
});

const GeneralVerifyOutputSchema = z.object({
  stillPresentIssueKeys: z.array(z.string()),
});

type LlmIssue = z.infer<typeof IssueSchema>;
type LlmGeneralIssue = z.infer<typeof GeneralIssueSchema>;
const DEFAULT_MAX_DIFF_TOKENS = 12000;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly model: ChatOpenAI;
  private readonly maxTokens: number;

  constructor(
    private readonly config: ConfigService,
    private readonly diffService: DiffService,
  ) {
    this.model = new ChatOpenAI({
      model: config.get<string>('OPENAI_MODEL') || 'gpt-4o',
      temperature: 0,
      apiKey: config.get<string>('OPENAI_API_KEY') || '',
    });
    this.maxTokens = parseInt(
      config.get<string>('MAX_DIFF_TOKENS') || String(DEFAULT_MAX_DIFF_TOKENS),
      10,
    );
  }

  async analyze(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rulesByFile: FileRulesContext[],
    prRules: RulePromptContext[] = [],
  ): Promise<ReviewIssue[]> {
    const rulesLookup = new Map(rulesByFile.map((entry) => [entry.filename, entry]));
    const filesWithRules = files.filter((file) => {
      const applicableRules = rulesLookup.get(file.filename)?.rules ?? [];
      return applicableRules.length > 0;
    });

    if (filesWithRules.length === 0 && prRules.length === 0) {
      return [];
    }

    const allIssues: LlmIssue[] = [];

    if (prRules.length > 0) {
      allIssues.push(
        ...(await this.analyzePrScopeWithFallback(
          prTitle,
          prBody,
          files,
          sharedContext,
          prRules,
        )),
      );
    }

    const batches = this.diffService.splitIntoBatches(filesWithRules, this.maxTokens);
    for (const batch of batches) {
      const issues = await this.analyzeBatchWithFallback(
        prTitle,
        prBody,
        batch.files,
        sharedContext,
        rulesByFile,
      );
      allIssues.push(...issues);
    }

    return this.consolidateIssues(allIssues, files);
  }

  async analyzeGeneral(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    agentsMdContent: string | undefined,
    previousIssues: GeneralIssue[],
    incrementalFiles?: DiffFile[],
  ): Promise<GeneralIssue[]> {
    if (files.length === 0) {
      return [];
    }

    const discoveryFiles =
      incrementalFiles ?? (previousIssues.length === 0 ? files : []);

    if (previousIssues.length === 0) {
      return this.discoverGeneralIssues(
        prTitle,
        prBody,
        discoveryFiles,
        agentsMdContent,
      );
    }

    const verifiedIssues = await this.verifyGeneralIssues(files, previousIssues);
    if (discoveryFiles.length === 0) {
      return this.applyGeneralIssueCaps(verifiedIssues);
    }

    const discoveredIssues = await this.discoverGeneralIssuesRaw(
      prTitle,
      prBody,
      discoveryFiles,
      agentsMdContent,
    );

    return this.applyGeneralIssueCaps(
      this.mergeGeneralIssues(verifiedIssues, discoveredIssues),
    );
  }

  private async discoverGeneralIssues(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    agentsMdContent: string | undefined,
  ): Promise<GeneralIssue[]> {
    return this.applyGeneralIssueCaps(
      await this.discoverGeneralIssuesRaw(
        prTitle,
        prBody,
        files,
        agentsMdContent,
      ),
    );
  }

  private async discoverGeneralIssuesRaw(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    agentsMdContent: string | undefined,
  ): Promise<GeneralIssue[]> {
    if (files.length === 0) {
      return [];
    }

    const batches = this.diffService.splitIntoBatches(files, this.maxTokens);
    const allIssues: LlmGeneralIssue[] = [];

    for (const batch of batches) {
      allIssues.push(
        ...(await this.discoverGeneralBatchWithFallback(
          prTitle,
          prBody,
          batch.files,
          agentsMdContent,
        )),
      );
    }

    const diffFiltered = allIssues.filter((issue) => issueMatchesDiff(issue, files));
    return this.deduplicateGeneralIssues(diffFiltered);
  }

  private async discoverGeneralBatchWithFallback(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    agentsMdContent: string | undefined,
  ): Promise<LlmGeneralIssue[]> {
    try {
      return await this.discoverGeneralBatch(prTitle, prBody, files, agentsMdContent);
    } catch (err) {
      if (!this.isPromptTooLargeError(err)) {
        throw err;
      }

      if (agentsMdContent) {
        this.logger.warn(
          `General-analysis prompt too large for ${files.length} file(s); retrying without AGENTS.md context`,
        );
        return this.discoverGeneralBatchWithFallback(prTitle, prBody, files, undefined);
      }

      const splitBatches = this.splitOversizedBatch(files);
      if (splitBatches.length > 1) {
        this.logger.warn(
          `General-analysis prompt still too large; splitting batch into ${splitBatches.length} smaller chunk(s)`,
        );

        const issues: LlmGeneralIssue[] = [];
        for (const splitBatch of splitBatches) {
          issues.push(
            ...(await this.discoverGeneralBatchWithFallback(
              prTitle,
              prBody,
              splitBatch,
              undefined,
            )),
          );
        }
        return issues;
      }

      this.logger.error(
        `General-analysis prompt is still too large for ${files[0]?.filename ?? 'unknown file'} even after fallback splitting`,
      );
      throw err;
    }
  }

  private async discoverGeneralBatch(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    agentsMdContent: string | undefined,
  ): Promise<LlmGeneralIssue[]> {
    const diff = this.formatDiffPlain(files);
    const prompt = this.buildGeneralDiscoveryPrompt(prTitle, prBody, diff, agentsMdContent);
    const structuredModel = this.model.withStructuredOutput(GeneralDiscoveryOutputSchema);

    const retryOn = (err: unknown): boolean => {
      if (this.isPromptTooLargeError(err)) {
        return false;
      }

      const status = (err as any)?.status ?? (err as any)?.response?.status;
      return status === 429 || status >= 500;
    };

    const result = await withRetry<{ issues: LlmGeneralIssue[] }>(
      () => structuredModel.invoke(prompt) as Promise<{ issues: LlmGeneralIssue[] }>,
      {
        maxAttempts: 3,
        delays: [2000, 4000, 8000],
        retryOn,
        onFinalFailure: async (err) => {
          if (this.isPromptTooLargeError(err)) {
            return;
          }
          this.logger.error(`General-analysis discovery failed after all retries: ${String(err)}`);
        },
      },
    );

    return result.issues;
  }

  private async verifyGeneralIssues(
    files: DiffFile[],
    previousIssues: GeneralIssue[],
  ): Promise<GeneralIssue[]> {
    const relevantFiles = files.filter((file) =>
      previousIssues.some((issue) => issue.file === file.filename),
    );

    if (relevantFiles.length === 0) {
      return [];
    }

    const diff = this.formatDiffPlain(relevantFiles);
    const prompt = this.buildGeneralVerifyPrompt(diff, previousIssues);
    const structuredModel = this.model.withStructuredOutput(GeneralVerifyOutputSchema);

    const result = await withRetry<{ stillPresentIssueKeys: string[] }>(
      () => structuredModel.invoke(prompt) as Promise<{ stillPresentIssueKeys: string[] }>,
      {
        maxAttempts: 3,
        delays: [2000, 4000, 8000],
        retryOn: (err) => {
          if (this.isPromptTooLargeError(err)) {
            return false;
          }
          const status = (err as any)?.status ?? (err as any)?.response?.status;
          return status === 429 || status >= 500;
        },
        onFinalFailure: async (err) => {
          if (this.isPromptTooLargeError(err)) {
            return;
          }
          this.logger.error(`General-analysis verification failed after all retries: ${String(err)}`);
        },
      },
    );

    const stillPresentKeys = new Set(result.stillPresentIssueKeys);
    return previousIssues.filter((issue) => stillPresentKeys.has(issue.issueKey));
  }

  private buildGeneralDiscoveryPrompt(
    prTitle: string,
    prBody: string,
    diff: string,
    agentsMdContent: string | undefined,
  ): string {
    return `You are an experienced software engineer doing a general-purpose code review of this Pull Request, similar to what GitHub Copilot's automated review does. Unlike a rule-checklist review, you are free to use your own judgement about real bugs, correctness issues, and robustness problems.

## Core Constraints
- Only report real, concrete problems: bugs, correctness issues, missing null/undefined/edge-case handling, logic errors, broken assumptions. Do not report pure style preferences or subjective taste.
- A review with zero issues is correct and expected. Do not force findings.
- Every issue must point to a line that exists in the diff hunks below. Do not reference lines outside the diff.
- If the diff is clean, return an empty issues array.
- Use the repository context (AGENTS.md) below, if present, to understand conventions and avoid flagging intentional patterns.

## Pull Request
Title: ${prTitle}
Description: ${prBody || '(none)'}

## Files Changed
${diff}

${agentsMdContent ? `## Repository Context (AGENTS.md)\n${agentsMdContent}\n` : ''}
Report only real issues. If nothing is wrong, return { "issues": [] }.`;
  }

  private buildGeneralVerifyPrompt(diff: string, previousIssues: GeneralIssue[]): string {
    const issuesList = previousIssues
      .map(
        (issue) =>
          `- issueKey: ${issue.issueKey}\n  file: ${issue.file}\n  description: ${issue.description}\n  snippet: ${issue.snippet}`,
      )
      .join('\n');

    return `You previously found the following general code-review issues on this Pull Request. Your only job now is to check, against the current state of the diff below, which of these issues are STILL present in the code.

## Rules
- Do not identify any new issue. Only judge the ones listed below.
- Mark an issue as still present only if the underlying problem still exists in the current diff.
- If a file or line was changed in a way that fixes the issue, mark it as resolved (do not include it).
- If you cannot find the file/snippet anymore in the diff, treat the issue as resolved.

## Previously Found Issues
${issuesList}

## Current Diff
${diff}

Return only the issueKey values that are still present.`;
  }

  private formatDiffPlain(files: DiffFile[]): string {
    return files
      .map((file) =>
        [`### ${file.filename} (${file.status})`, '```diff', file.patch, '```'].join('\n'),
      )
      .join('\n\n');
  }

  private formatCompactDiff(files: DiffFile[]): string {
    return files
      .map((file) => {
        const excerpt = this.compactPatch(file.patch);
        return [
          `### ${file.filename} (${file.status})`,
          '```diff',
          excerpt || '(no diff hunk available)',
          '```',
        ].join('\n');
      })
      .join('\n\n');
  }

  private deduplicateGeneralIssues(issues: LlmGeneralIssue[]): GeneralIssue[] {
    const unique = new Map<string, GeneralIssue>();

    for (const issue of issues) {
      const key = buildGeneralIssueKey(issue);
      if (!unique.has(key)) {
        unique.set(key, { ...issue, issueKey: key });
      }
    }

    return Array.from(unique.values());
  }

  private mergeGeneralIssues(
    verifiedIssues: GeneralIssue[],
    discoveredIssues: GeneralIssue[],
  ): GeneralIssue[] {
    const merged = new Map<string, GeneralIssue>();

    for (const issue of [...verifiedIssues, ...discoveredIssues]) {
      if (!merged.has(issue.issueKey)) {
        merged.set(issue.issueKey, issue);
      }
    }

    return Array.from(merged.values());
  }

  private applyGeneralIssueCaps(issues: GeneralIssue[]): GeneralIssue[] {
    const caps: Record<GeneralIssue['criticality'], number> = {
      high: this.parseGeneralCap(this.config.get<string>('GENERAL_ISSUE_CAP_HIGH'), 3),
      medium: this.parseGeneralCap(this.config.get<string>('GENERAL_ISSUE_CAP_MEDIUM'), 3),
      low: this.parseGeneralCap(this.config.get<string>('GENERAL_ISSUE_CAP_LOW'), 3),
    };
    const counts: Record<GeneralIssue['criticality'], number> = { high: 0, medium: 0, low: 0 };

    return issues.filter((issue) => {
      if (counts[issue.criticality] >= caps[issue.criticality]) {
        return false;
      }
      counts[issue.criticality] += 1;
      return true;
    });
  }

  private parseGeneralCap(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private async analyzeBatchWithFallback(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rulesByFile: FileRulesContext[],
  ): Promise<LlmIssue[]> {
    try {
      return await this.analyzeBatch(
        prTitle,
        prBody,
        files,
        sharedContext,
        rulesByFile,
      );
    } catch (err) {
      if (!this.isPromptTooLargeError(err)) {
        throw err;
      }

      const estimatedTokens = this.estimateBatchTokens(
        prTitle,
        prBody,
        files,
        sharedContext,
        rulesByFile,
      );

      if (sharedContext) {
        this.logger.warn(
          `LLM prompt too large (~${estimatedTokens} tokens) for ${files.length} file(s); retrying without shared context`,
        );
        return this.analyzeBatchWithFallback(
          prTitle,
          prBody,
          files,
          '',
          rulesByFile,
        );
      }

      const splitBatches = this.splitOversizedBatch(files);
      if (splitBatches.length > 1) {
        this.logger.warn(
          `LLM prompt too large (~${estimatedTokens} tokens); splitting batch into ${splitBatches.length} smaller chunk(s)`,
        );

        const issues: LlmIssue[] = [];
        for (const batch of splitBatches) {
          issues.push(
            ...(await this.analyzeBatchWithFallback(
              prTitle,
              prBody,
              batch,
              '',
              rulesByFile,
            )),
          );
        }
        return issues;
      }

      this.logger.error(
        `LLM prompt is still too large for ${files[0]?.filename ?? 'unknown file'} even after fallback splitting`,
      );
      throw err;
    }
  }

  private async analyzePrScopeWithFallback(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    prRules: RulePromptContext[],
    compactMode = false,
  ): Promise<LlmIssue[]> {
    try {
      return await this.analyzePrScope(
        prTitle,
        prBody,
        files,
        sharedContext,
        prRules,
        compactMode,
      );
    } catch (err) {
      if (!this.isPromptTooLargeError(err)) {
        throw err;
      }

      const estimatedTokens = this.estimatePrScopeTokens(
        prTitle,
        prBody,
        files,
        sharedContext,
        prRules,
        compactMode,
      );

      if (sharedContext) {
        this.logger.warn(
          `PR-scope prompt too large (~${estimatedTokens} tokens); retrying without shared context`,
        );
        return this.analyzePrScopeWithFallback(
          prTitle,
          prBody,
          files,
          '',
          prRules,
          compactMode,
        );
      }

      if (!compactMode) {
        this.logger.warn(
          `PR-scope prompt too large (~${estimatedTokens} tokens); retrying with compact diff excerpts`,
        );
        return this.analyzePrScopeWithFallback(
          prTitle,
          prBody,
          files,
          '',
          prRules,
          true,
        );
      }

      this.logger.error(
        `PR-scope prompt is still too large for ${files.length} file(s) even after compact fallback`,
      );
      throw err;
    }
  }

  private async analyzePrScope(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    prRules: RulePromptContext[],
    compactMode: boolean,
  ): Promise<LlmIssue[]> {
    if (prRules.length === 0 || files.length === 0) {
      return [];
    }

    const diff = compactMode
      ? this.formatCompactDiff(files)
      : this.formatDiffPlain(files);
    const prompt = this.buildPrScopePrompt(
      prTitle,
      prBody,
      diff,
      sharedContext,
      prRules,
      compactMode,
    );

    const structuredModel = this.model.withStructuredOutput(LlmOutputSchema);

    const retryOn = (err: unknown): boolean => {
      if (this.isPromptTooLargeError(err)) {
        return false;
      }

      const status = (err as any)?.status ?? (err as any)?.response?.status;
      return status === 429 || status >= 500;
    };

    const result = await withRetry<{ issues: LlmIssue[] }>(
      () => structuredModel.invoke(prompt) as Promise<{ issues: LlmIssue[] }>,
      {
        maxAttempts: 3,
        delays: [2000, 4000, 8000],
        retryOn,
        onFinalFailure: async (err) => {
          if (this.isPromptTooLargeError(err)) {
            return;
          }

          this.logger.error(
            `PR-scope analysis failed after all retries: ${String(err)}`,
          );
        },
      },
    );

    return result.issues;
  }

  private async analyzeBatch(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rulesByFile: FileRulesContext[],
  ): Promise<LlmIssue[]> {
    const rulesLookup = new Map(rulesByFile.map((entry) => [entry.filename, entry]));
    const filesWithRules = files.filter((file) => {
      const applicableRules = rulesLookup.get(file.filename)?.rules ?? [];
      return applicableRules.length > 0;
    });

    if (filesWithRules.length === 0) {
      return [];
    }

    const diff = this.formatDiffWithRules(filesWithRules, rulesLookup);
    const prompt = this.buildPrompt(
      prTitle,
      prBody,
      diff,
      sharedContext,
    );

    const structuredModel = this.model.withStructuredOutput(LlmOutputSchema);

    const retryOn = (err: unknown): boolean => {
      if (this.isPromptTooLargeError(err)) {
        return false;
      }

      const status = (err as any)?.status ?? (err as any)?.response?.status;
      return status === 429 || status >= 500;
    };

    const result = await withRetry<{ issues: LlmIssue[] }>(
      () => structuredModel.invoke(prompt) as Promise<{ issues: LlmIssue[] }>,
      {
        maxAttempts: 3,
        delays: [2000, 4000, 8000],
        retryOn,
        onFinalFailure: async (err) => {
          if (this.isPromptTooLargeError(err)) {
            return;
          }

          this.logger.error(
            `LLM analysis failed after all retries: ${String(err)}`,
          );
        },
      },
    );

    return result.issues;
  }

  private buildPrompt(
    prTitle: string,
    prBody: string,
    diff: string,
    sharedContext: string,
  ): string {
    return `You are a strict code reviewer. Your job is to enforce the rules listed below — nothing else.

## Core Constraints
- Only report violations of the rules listed under each file. Do not invent issues outside those rules.
- A review with zero issues is correct and expected. Do not force findings.
- Do not report style preferences, general improvements, or best practices not covered by the rules.
- Architectural refactoring is reportable when it maps to a specific listed rule (e.g. business logic in a controller that should be in a service/model). In that case, cite the rule and state where the code should move.
- Every issue must point to a line that exists in the diff hunks below. Do not reference lines outside the diff.
- Shared/imported files are read-only context. Never create an issue targeting them.
- If the diff is clean relative to the rules, return an empty issues array.
- \`description\` and \`reason\` must say different things. \`description\` states the problem in general terms. \`reason\` must explain, referencing the actual code in \`snippet\`, why this specific occurrence violates the rule. Never set \`reason\` to just the rule name or a copy of \`description\`.

## Pull Request
Title: ${prTitle}
Description: ${prBody || '(none)'}

## Files Changed
${diff}

${sharedContext ? `## Shared/Imported Files Context (read-only)\n${sharedContext}\n` : ''}
Report only violations. If no rule is violated, return { "issues": [] }.`;
  }

  private buildPrScopePrompt(
    prTitle: string,
    prBody: string,
    diff: string,
    sharedContext: string,
    prRules: RulePromptContext[],
    compactMode: boolean,
  ): string {
    return `You are a strict code reviewer. Your job is to enforce only the PR-level rules listed below.

## Core Constraints
- Evaluate the Pull Request as a whole. These rules may depend on the presence or absence of companion files elsewhere in the PR.
- Only report violations of the PR-level rules listed below. Do not invent issues outside those rules.
- A review with zero issues is correct and expected. Do not force findings.
- Every issue must point to a line that exists in the changed snippets below. If the violation is about a missing companion file, attach the issue to the changed source snippet that requires that companion file.
- Shared/imported files are read-only context. Never create an issue targeting them.
- If the PR is compliant with the listed rules, return an empty issues array.
- \`description\` and \`reason\` must say different things. \`description\` states the problem in general terms. \`reason\` must explain why this PR violates the rule, citing the actual changed snippet and the missing or inconsistent companion evidence elsewhere in the PR.

## Pull Request
Title: ${prTitle}
Description: ${prBody || '(none)'}

## PR-Level Rules
${this.formatRulesList(prRules)}

## Files Changed
${diff}

${compactMode ? '## Notes\nThe full diff was too large, so the snippets above are compact excerpts. Be extra conservative and report only issues that are clearly supported.\n\n' : ''}${sharedContext ? `## Shared/Imported Files Context (read-only)\n${sharedContext}\n` : ''}Report only violations. If no rule is violated, return { "issues": [] }.`;
  }

  private formatDiffWithRules(
    files: DiffFile[],
    rulesLookup: Map<string, FileRulesContext>,
  ): string {
    return files
      .map((file) => {
        const ruleContext = rulesLookup.get(file.filename);
        const rulesText = this.formatRulesList(ruleContext?.rules ?? []);

        return [
          `### ${file.filename} (${file.status})`,
          `Language: ${ruleContext?.language ?? 'unknown'}`,
          'Applicable Rules:',
          rulesText || '- None',
          '```diff',
          file.patch,
          '```',
        ].join('\n');
      })
      .join('\n\n');
  }

  private formatRulesList(rules: RulePromptContext[]): string {
    return rules
      .map((rule) => {
        const lines = [
          `- [${rule.criticality.toUpperCase()}] ${rule.title}: ${rule.description}`,
        ];
        if (rule.whyThisRuleExists) {
          lines.push(`  Why this rule exists: ${rule.whyThisRuleExists}`);
        }
        return lines.join('\n');
      })
      .join('\n');
  }

  private consolidateIssues(issues: LlmIssue[], files: DiffFile[]): ReviewIssue[] {
    const diffOnlyIssues = this.filterIssuesToChangedDiff(files, issues);
    return this.deduplicateIssues(diffOnlyIssues);
  }

  private filterIssuesToChangedDiff(files: DiffFile[], issues: LlmIssue[]): LlmIssue[] {
    return issues.filter((issue) => issueMatchesDiff(issue, files));
  }

  private deduplicateIssues(issues: LlmIssue[]): ReviewIssue[] {
    const uniqueIssues = new Map<string, ReviewIssue>();

    for (const issue of issues) {
      const key = buildIssueKey(issue);
      if (!uniqueIssues.has(key)) {
        uniqueIssues.set(key, {
          ...issue,
          issueKey: key,
        });
      }
    }

    return Array.from(uniqueIssues.values());
  }

  private isPromptTooLargeError(err: unknown): boolean {
    const message = [
      (err as any)?.message,
      (err as any)?.error?.message,
      (err as any)?.response?.data?.error?.message,
      String(err),
    ]
      .filter(Boolean)
      .join(' ');

    return /request too large/i.test(message) || /tokens per min/i.test(message);
  }

  private estimateBatchTokens(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rulesByFile: FileRulesContext[],
  ): number {
    const rulesLookup = new Map(rulesByFile.map((entry) => [entry.filename, entry]));
    const diff = this.formatDiffWithRules(files, rulesLookup);
    return this.estimateTokens(this.buildPrompt(prTitle, prBody, diff, sharedContext));
  }

  private estimatePrScopeTokens(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    prRules: RulePromptContext[],
    compactMode: boolean,
  ): number {
    const diff = compactMode
      ? this.formatCompactDiff(files)
      : this.formatDiffPlain(files);
    return this.estimateTokens(
      this.buildPrScopePrompt(
        prTitle,
        prBody,
        diff,
        sharedContext,
        prRules,
        compactMode,
      ),
    );
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private splitOversizedBatch(files: DiffFile[]): DiffFile[][] {
    if (files.length > 1) {
      const midpoint = Math.ceil(files.length / 2);
      return [files.slice(0, midpoint), files.slice(midpoint)];
    }

    const [file] = files;
    if (!file) {
      return [];
    }

    const hunkFiles = this.splitFileByHunk(file);
    if (hunkFiles.length > 1) {
      const midpoint = Math.ceil(hunkFiles.length / 2);
      return [hunkFiles.slice(0, midpoint), hunkFiles.slice(midpoint)];
    }

    return [files];
  }

  private splitFileByHunk(file: DiffFile): DiffFile[] {
    const hunkPatches: string[] = [];
    let currentHunk: string[] = [];

    const flushHunk = () => {
      if (currentHunk.length === 0) {
        return;
      }
      hunkPatches.push(currentHunk.join('\n'));
      currentHunk = [];
    };

    for (const line of file.patch.split('\n')) {
      if (line.startsWith('@@')) {
        flushHunk();
      }
      currentHunk.push(line);
    }

    flushHunk();

    if (hunkPatches.length <= 1) {
      return [file];
    }

    return hunkPatches.map((patch) => ({
      ...file,
      patch,
    }));
  }

  private compactPatch(patch: string): string {
    const trimmed = patch.trim();
    if (!trimmed) {
      return '';
    }

    const lines = trimmed.split('\n');
    const maxLines = 24;
    if (lines.length <= maxLines) {
      return trimmed;
    }

    return [...lines.slice(0, maxLines), '... [truncated]'].join('\n');
  }
}
