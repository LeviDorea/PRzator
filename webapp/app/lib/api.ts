const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function getAuthHeader(): string {
  if (typeof window === 'undefined') return '';
  const user = localStorage.getItem('api_user') || '';
  const password = localStorage.getItem('api_password') || '';
  return 'Basic ' + btoa(`${user}:${password}`);
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
      ...((options.headers as Record<string, string>) || {}),
    },
  });

  if (!res.ok) {
    if (res.status === 401) throw new Error('UNAUTHORIZED');
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.message || message;
    } catch {}
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

export interface Repository {
  id: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  installationId: number;
  webhookId?: number;
  createdAt: string;
}

export interface Rule {
  id: string;
  title: string;
  description: string;
  criticality: 'low' | 'medium' | 'high';
  fileGlobs: string[];
  targetLanguage?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LlmIssue {
  file: string;
  snippet: string;
  description: string;
  reason: string;
  criticality: 'low' | 'medium' | 'high';
  rule: string;
}

export interface Analysis {
  id: string;
  repositoryId: string;
  prNumber: number;
  prTitle: string;
  commitSha: string;
  score: number;
  issues: LlmIssue[];
  published: boolean;
  createdAt: string;
}

export interface ScoringConfig {
  id: string;
  high: number;
  medium: number;
  low: number;
}

export const api = {
  async testAuth(): Promise<void> {
    await apiFetch('/analyses');
  },

  async getAnalyses(): Promise<Analysis[]> {
    return apiFetch('/analyses');
  },

  async getAnalysesByRepo(repositoryId: string): Promise<Analysis[]> {
    return apiFetch(`/analyses/repo/${repositoryId}`);
  },

  async getRules(): Promise<Rule[]> {
    return apiFetch('/rules');
  },

  async createRule(data: {
    title: string;
    description: string;
    criticality: 'low' | 'medium' | 'high';
    fileGlobs?: string[];
    targetLanguage?: string;
  }): Promise<Rule> {
    return apiFetch('/rules', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateRule(
    id: string,
    data: Partial<{
      title: string;
      description: string;
      criticality: 'low' | 'medium' | 'high';
      fileGlobs: string[];
      targetLanguage: string;
    }>,
  ): Promise<Rule> {
    return apiFetch(`/rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteRule(id: string): Promise<void> {
    return apiFetch(`/rules/${id}`, { method: 'DELETE' });
  },

  async associateRuleToRepos(id: string, repositoryIds: string[]): Promise<void> {
    return apiFetch(`/rules/${id}/repos`, {
      method: 'POST',
      body: JSON.stringify({ repositoryIds }),
    });
  },

  async getRepositories(): Promise<Repository[]> {
    return apiFetch('/repos');
  },

  async deleteRepository(id: string): Promise<void> {
    return apiFetch(`/repos/${id}`, { method: 'DELETE' });
  },

  async getScoringConfig(): Promise<ScoringConfig> {
    return apiFetch('/config/scoring');
  },

  async updateScoringConfig(data: {
    high?: number;
    medium?: number;
    low?: number;
  }): Promise<ScoringConfig> {
    return apiFetch('/config/scoring', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
};
