export interface AnalysisRequestedEvent {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  installationId: number;
  baseSha: string;
  commitSha: string;
  repositoryId: string;
}

export interface AnalysisCompletedEvent {
  analysisId: string;
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
}

export interface AnalysisFailedEvent {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  error: string;
}

export const ANALYSIS_REQUESTED = 'analysis.requested';
export const ANALYSIS_COMPLETED = 'analysis.completed';
export const ANALYSIS_FAILED = 'analysis.failed';
