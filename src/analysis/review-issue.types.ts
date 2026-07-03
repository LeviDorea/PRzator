export type ReviewCriticality = 'low' | 'medium' | 'high';
export type ReviewIssueBaselineStatus = 'new' | 'persistent' | 'known_debt';

export interface ReviewIssue {
  file: string;
  snippet: string;
  description: string;
  reason: string;
  criticality: ReviewCriticality;
  rule: string;
  issueKey?: string;
  baselineStatus?: ReviewIssueBaselineStatus;
  advisory?: boolean;
}
