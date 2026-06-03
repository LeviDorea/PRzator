import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { withRetry } from '../common/utils/retry.util';
import { DiffFile, DiffService } from './diff.service';

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

export type LlmIssue = z.infer<typeof IssueSchema>;

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
    this.maxTokens = parseInt(config.get<string>('MAX_DIFF_TOKENS') || '80000', 10);
  }

  async analyze(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rules: Array<{ title: string; description: string; criticality: string }>,
  ): Promise<LlmIssue[]> {
    const batches = this.diffService.splitIntoBatches(files, this.maxTokens);
    const allIssues: LlmIssue[] = [];

    for (const batch of batches) {
      const issues = await this.analyzeBatch(
        prTitle,
        prBody,
        batch.files,
        sharedContext,
        rules,
      );
      allIssues.push(...issues);
    }

    return allIssues;
  }

  private async analyzeBatch(
    prTitle: string,
    prBody: string,
    files: DiffFile[],
    sharedContext: string,
    rules: Array<{ title: string; description: string; criticality: string }>,
  ): Promise<LlmIssue[]> {
    const diff = this.diffService.formatDiffForPrompt(files);
    const rulesText = rules
      .map((r) => `- [${r.criticality.toUpperCase()}] ${r.title}: ${r.description}`)
      .join('\n');

    const prompt = `You are an expert code reviewer. Analyze the following Pull Request and identify issues based on the provided rules.

PR Title: ${prTitle}
PR Description: ${prBody || '(none)'}

## Files Changed
${diff}

${sharedContext ? `## Shared/Imported Files Context\n${sharedContext}` : ''}

## Review Rules
${rulesText}

Identify ALL real issues found. For each issue, specify the file, a code snippet illustrating the problem, a clear description, the reason it is a problem, the criticality level (low/medium/high), and the rule violated.
If no issues are found, return an empty issues array.`;

    const structuredModel = this.model.withStructuredOutput(LlmOutputSchema);

    const retryOn = (err: unknown): boolean => {
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
          this.logger.error('LLM analysis failed after all retries', { error: String(err) });
        },
      },
    );

    return result.issues;
  }
}
