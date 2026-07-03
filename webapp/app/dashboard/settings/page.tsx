'use client';

import { useState, useEffect, FormEvent } from 'react';
import { api, ScoringConfig } from '@/app/lib/api';

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
        <div
          className={`h-2.5 rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span
        className={`text-sm font-bold w-14 text-right ${
          score >= 80 ? 'text-emerald-600' : score >= 60 ? 'text-amber-600' : 'text-red-600'
        }`}
      >
        {score}/100
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const [config, setConfig] = useState<ScoringConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [form, setForm] = useState({ high: 10, medium: 4, low: 1 });

  useEffect(() => {
    api
      .getScoringConfig()
      .then((data) => {
        setConfig(data);
        setForm({ high: data.high, medium: data.medium, low: data.low });
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSuccess(false);
    setError('');
    try {
      const updated = await api.updateScoringConfig(form);
      setConfig(updated);
      setForm({ high: updated.high, medium: updated.medium, low: updated.low });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const examples = [
    {
      label: '1 high issue',
      score: Math.max(0, 100 - form.high),
      detail: `100 − ${form.high}`,
    },
    {
      label: '1 medium issue',
      score: Math.max(0, 100 - form.medium),
      detail: `100 − ${form.medium}`,
    },
    {
      label: '3 low issues',
      score: Math.max(0, 100 - form.low * 3),
      detail: `100 − ${form.low * 3}`,
    },
    {
      label: '1 high + 2 medium + 3 low',
      score: Math.max(0, 100 - form.high - form.medium * 2 - form.low * 3),
      detail: `100 − ${form.high} − ${form.medium * 2} − ${form.low * 3}`,
    },
  ];

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 text-sm mt-1">Configure how PR scores are calculated</p>
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!loading && (
        <div className="max-w-2xl space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-900 mb-1">Scoring Weights</h2>
            <p className="text-sm text-slate-500 mb-6">
              Each issue deducts points from a base score of{' '}
              <span className="font-semibold text-slate-700">100</span>. Set how many points each
              criticality level deducts.
            </p>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-3 gap-4">
                {(
                  [
                    { key: 'high', label: 'High', color: 'bg-red-500', labelColor: 'text-red-600' },
                    { key: 'medium', label: 'Medium', color: 'bg-amber-500', labelColor: 'text-amber-600' },
                    { key: 'low', label: 'Low', color: 'bg-emerald-500', labelColor: 'text-emerald-600' },
                  ] as const
                ).map(({ key, label, color, labelColor }) => (
                  <div key={key}>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
                        <span className={labelColor}>{label}</span>
                      </span>
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={form[key]}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, [key]: parseInt(e.target.value) || 0 }))
                        }
                        className="w-full px-3 py-2.5 pr-10 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-medium">
                        pts
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {error}
                </div>
              )}

              {success && (
                <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Settings saved successfully
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-900 mb-1">Score Preview</h2>
            <p className="text-sm text-slate-500 mb-5">
              How scores would look with the current weights
            </p>
            <div className="space-y-4">
              {examples.map((ex) => (
                <div key={ex.label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-slate-600 font-medium">{ex.label}</span>
                    <span className="text-xs text-slate-400 font-mono">{ex.detail}</span>
                  </div>
                  <ScoreBar score={ex.score} />
                </div>
              ))}
            </div>
          </div>

          {config && (
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4">
              <p className="text-xs text-slate-400">
                Config ID: <code className="font-mono">{config.id}</code>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
