import { Injectable } from '@nestjs/common';

export interface ScoringWeights {
  high: number;
  medium: number;
  low: number;
}

export interface IssueForScoring {
  criticality: 'high' | 'medium' | 'low';
}

@Injectable()
export class ScoringService {
  calculate(issues: IssueForScoring[], weights: ScoringWeights): number {
    const deduction = issues.reduce((sum, issue) => {
      return sum + (weights[issue.criticality] ?? 0);
    }, 0);
    return Math.max(0, 100 - deduction);
  }
}
