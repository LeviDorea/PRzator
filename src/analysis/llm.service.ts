import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { withRetry } from '../common/utils/retry.util';
import { DiffFile, DiffService } from './diff.service';
import { FileRulesContext } from '../rules/rules.service';
import { ReviewIssue } from './review-issue.types';
import { buildIssueKey, issueMatchesDiff } from './review-issue.util';

const IssueSchema = z.object({
  file: z.string(),
  snippet: z.string(),
  description: z.string(),
  reason: z.string(),
  criticality: z.enum(['low', 'medium', 'high']),
  rule: z.string(),
});

const LlmOutputSchema = z.object({
  issues: z.array(IssueSchema),
});

type LlmIssue = z.infer<typeof IssueSchema>;
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
    agentContext?: string,
  ): Promise<ReviewIssue[]> {
    const rulesLookup = new Map(rulesByFile.map((entry) => [entry.filename, entry]));
    const filesWithRules = files.filter((file) => {
      const applicableRules = rulesLookup.get(file.filename)?.rules ?? [];
      return applicableRules.length > 0;
    });

    if (filesWithRules.length === 0) {
      return [];
    }

    const batches = this.diffService.splitIntoBatches(filesWithRules, this.maxTokens);
    const allIssues: LlmIssue[] = [];

    for (const batch of batches) {
      const issues = await this.analyzeBatchWithFallback(
        prTitle,
        prBody,
        batch.files,
        sharedContext,
        rulesByFile,
        agentContext,
      );
      allIssues.push(...issues);
    }

    return this.consolidateIssues(allIssues, files);
  }

  private async analyzeBatchWithFallback(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rulesByFile: FileRulesContext[],
    agentContext?: string,
  ): Promise<LlmIssue[]> {
    try {
      return await this.analyzeBatch(
        prTitle,
        prBody,
        files,
        sharedContext,
        rulesByFile,
        agentContext,
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
          agentContext,
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
              agentContext,
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

  private async analyzeBatch(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rulesByFile: FileRulesContext[],
    agentContext?: string,
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
      agentContext,
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
    agentContext?: string,
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

## Pull Request
Title: ${prTitle}
Description: ${prBody || '(none)'}

## Files Changed
${diff}

${sharedContext ? `## Shared/Imported Files Context (read-only)\n${sharedContext}\n` : ''}
${agentContext ? `## Repository-Specific Rules (from AGENTS.md)\n${agentContext}\n` : ''}
Report only violations. If no rule is violated, return { "issues": [] }.`;
  }

  private formatDiffWithRules(
    files: DiffFile[],
    rulesLookup: Map<string, FileRulesContext>,
  ): string {
    return files
      .map((file) => {
        const ruleContext = rulesLookup.get(file.filename);
        const rulesText = (ruleContext?.rules ?? [])
          .map((rule) => `- [${rule.criticality.toUpperCase()}] ${rule.title}: ${rule.description}`)
          .join('\n');

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
}
