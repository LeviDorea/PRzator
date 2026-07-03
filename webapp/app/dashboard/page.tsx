'use client';

import { useState, useEffect } from 'react';
import { api, Analysis, Repository, LlmIssue } from '@/app/lib/api';

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : score >= 60
        ? 'text-amber-700 bg-amber-50 border-amber-200'
        : 'text-red-700 bg-red-50 border-red-200';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${color}`}>
      {score}/100
    </span>
  );
}

function IssueCounts({ issues }: { issues: LlmIssue[] }) {
  const high = issues.filter((i) => i.criticality === 'high').length;
  const medium = issues.filter((i) => i.criticality === 'medium').length;
  const low = issues.filter((i) => i.criticality === 'low').length;
  if (issues.length === 0) {
    return <span className="text-slate-400 text-xs">No issues</span>;
  }
  return (
    <div className="flex items-center gap-1.5">
      {high > 0 && (
        <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-md font-medium">
          <span className="w-1.5 h-1.5 bg-red-500 rounded-full" />
          {high}H
        </span>
      )}
      {medium > 0 && (
        <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-md font-medium">
          <span className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
          {medium}M
        </span>
      )}
      {low > 0 && (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md font-medium">
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
          {low}L
        </span>
      )}
    </div>
  );
}

function IssueCard({ issue }: { issue: LlmIssue }) {
  const styles = {
    high: { border: 'border-red-200 bg-red-50', badge: 'bg-red-200 text-red-800' },
    medium: { border: 'border-amber-200 bg-amber-50', badge: 'bg-amber-200 text-amber-800' },
    low: { border: 'border-emerald-200 bg-emerald-50', badge: 'bg-emerald-200 text-emerald-800' },
  }[issue.criticality];

  return (
    <div className={`rounded-xl border p-4 ${styles.border}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wide ${styles.badge}`}>
            {issue.criticality}
          </span>
          <span className="text-xs text-slate-500">Rule: {issue.rule}</span>
        </div>
        <span className="text-xs text-slate-400 font-mono flex-shrink-0 truncate max-w-48">{issue.file}</span>
      </div>
      <p className="text-sm font-semibold text-slate-800">{issue.description}</p>
      <p className="text-xs text-slate-600 mt-1 leading-relaxed">{issue.reason}</p>
      {issue.snippet && (
        <pre className="mt-2.5 text-xs bg-white/80 border border-slate-200 rounded-lg p-3 overflow-x-auto font-mono leading-relaxed whitespace-pre-wrap">
          {issue.snippet}
        </pre>
      )}
    </div>
  );
}

function AnalysisRow({
  analysis,
  repoName,
}: {
  analysis: Analysis;
  repoName: string;
}) {
  const [open, setOpen] = useState(false);
  const issues = (analysis.issues as LlmIssue[]) || [];

  return (
    <>
      <tr
        className="hover:bg-slate-50 cursor-pointer transition-colors"
        onClick={() => setOpen(true)}
      >
        <td className="px-6 py-4 text-sm font-medium text-slate-700">{repoName}</td>
        <td className="px-6 py-4 text-sm">
          <span className="text-slate-400 font-mono text-xs mr-2">#{analysis.prNumber}</span>
          <span className="text-slate-900 font-medium">{analysis.prTitle}</span>
        </td>
        <td className="px-6 py-4">
          <ScoreBadge score={analysis.score} />
        </td>
        <td className="px-6 py-4">
          <IssueCounts issues={issues} />
        </td>
        <td className="px-6 py-4 text-xs text-slate-400">
          {new Date(analysis.createdAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={5} className="p-0">
            <div
              className="fixed inset-0 z-50 overflow-y-auto"
              aria-modal="true"
              role="dialog"
            >
              <div
                className="fixed inset-0 bg-black/40 backdrop-blur-sm"
                onClick={() => setOpen(false)}
              />
              <div className="relative flex min-h-screen items-start justify-center p-4 pt-12">
                <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl">
                  <div className="flex items-start justify-between p-6 border-b border-slate-200">
                    <div>
                      <p className="text-xs text-slate-400 font-medium mb-1">
                        {repoName} · PR #{analysis.prNumber} ·{' '}
                        <code className="font-mono">{analysis.commitSha.slice(0, 8)}</code>
                      </p>
                      <h2 className="text-lg font-bold text-slate-900">{analysis.prTitle}</h2>
                    </div>
                    <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                      <ScoreBadge score={analysis.score} />
                      <button
                        onClick={() => setOpen(false)}
                        className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className="p-6">
                    {issues.length === 0 ? (
                      <div className="text-center py-10">
                        <svg className="w-12 h-12 mx-auto mb-3 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <p className="text-slate-500 font-medium">No issues found</p>
                        <p className="text-slate-400 text-sm">This PR passed all review rules.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm text-slate-500 mb-4">
                          {issues.length} issue{issues.length !== 1 ? 's' : ''} found
                        </p>
                        {issues.map((issue, i) => (
                          <IssueCard key={i} issue={issue} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function AnalysesPage() {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getAnalyses(), api.getRepositories()])
      .then(([a, r]) => {
        setAnalyses(a);
        setRepos(r);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const repoMap = Object.fromEntries(repos.map((r) => [r.id, r.fullName]));

  const avgScore =
    analyses.length > 0
      ? Math.round(analyses.reduce((s, a) => s + a.score, 0) / analyses.length)
      : null;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Analyses</h1>
        <p className="text-slate-500 text-sm mt-1">AI-powered code review results for all pull requests</p>
      </div>

      {!loading && !error && analyses.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Total Analyses</p>
            <p className="text-3xl font-bold text-slate-900">{analyses.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Avg Score</p>
            <p className={`text-3xl font-bold ${avgScore != null && avgScore >= 80 ? 'text-emerald-600' : avgScore != null && avgScore >= 60 ? 'text-amber-600' : 'text-red-600'}`}>
              {avgScore ?? '—'}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Repositories</p>
            <p className="text-3xl font-bold text-slate-900">{repos.length}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">{error}</div>
      )}

      {!loading && !error && analyses.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          <svg className="w-14 h-14 mx-auto mb-4 text-slate-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p className="font-medium text-slate-500">No analyses yet</p>
          <p className="text-sm mt-1">Analyses are created automatically when pull requests are opened.</p>
        </div>
      )}

      {!loading && !error && analyses.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Repository
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Pull Request
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Score
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Issues
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Date
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {analyses.map((a) => (
                <AnalysisRow
                  key={a.id}
                  analysis={a}
                  repoName={repoMap[a.repositoryId] || a.repositoryId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
