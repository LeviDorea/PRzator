import { Injectable } from '@nestjs/common';
import { ReviewIssue } from '../analysis/review-issue.types';

export interface CommentData {
  score: number;
  prTitle: string;
  issues: ReviewIssue[];
}

@Injectable()
export class CommentService {
  private readonly ICONS: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  };

  private readonly LABELS: Record<string, string> = {
    high: 'Alta Criticidade',
    medium: 'Média Criticidade',
    low: 'Baixa Criticidade',
  };

  formatMarkdown(data: CommentData): string {
    const { score, issues } = data;
    const indicator = score >= 80 ? '✅' : score >= 50 ? '⚠️' : '❌';
    const knownDebtIssues = issues.filter((issue) => issue.baselineStatus === 'known_debt');
    const scoredIssues = issues.filter(
      (issue) => !issue.advisory && issue.baselineStatus !== 'known_debt',
    );
    const advisoryIssues = issues.filter(
      (issue) => issue.advisory && issue.baselineStatus !== 'known_debt',
    );

    const sections: string[] = [];

    for (const level of ['high', 'medium', 'low'] as const) {
      const levelIssues = scoredIssues.filter((i) => i.criticality === level);
      if (levelIssues.length === 0) continue;

      const icon = this.ICONS[level];
      const label = this.LABELS[level];

      sections.push(`### ${icon} ${label} (${levelIssues.length} problema${levelIssues.length > 1 ? 's' : ''})`);
      sections.push('');

      for (const issue of levelIssues) {
        sections.push(`**Arquivo:** \`${issue.file}\``);
        sections.push(`**Regra:** ${issue.rule}`);
        if (issue.baselineStatus === 'new') {
          sections.push('**Status:** Nova neste commit');
        }
        if (issue.baselineStatus === 'persistent') {
          sections.push('**Status:** Persistente');
        }
        sections.push(`**Problema:** ${issue.description}`);
        sections.push(`**Motivo:** ${issue.reason}`);
        if (issue.snippet) {
          sections.push('**Trecho:**');
          sections.push('```');
          sections.push(issue.snippet);
          sections.push('```');
        }
        sections.push('');
      }
    }

    if (knownDebtIssues.length > 0) {
      sections.push(`### 🧱 Known Debt (${knownDebtIssues.length} sem impacto na nota)`);
      sections.push('');

      for (const issue of knownDebtIssues) {
        sections.push(`**Arquivo:** \`${issue.file}\``);
        sections.push(`**Regra:** ${issue.rule}`);
        sections.push('**Status:** Preexistente / descoberto agora');
        sections.push(`**Problema:** ${issue.description}`);
        sections.push(`**Motivo:** ${issue.reason}`);
        if (issue.snippet) {
          sections.push('**Trecho:**');
          sections.push('```');
          sections.push(issue.snippet);
          sections.push('```');
        }
        sections.push('');
      }
    }

    if (advisoryIssues.length > 0) {
      sections.push(`### ℹ️ Observações Adicionais (${advisoryIssues.length} sem impacto na nota)`);
      sections.push('');

      for (const issue of advisoryIssues) {
        sections.push(`**Arquivo:** \`${issue.file}\``);
        sections.push(`**Regra:** ${issue.rule}`);
        sections.push(`**Problema:** ${issue.description}`);
        sections.push(`**Motivo:** ${issue.reason}`);
        if (issue.snippet) {
          sections.push('**Trecho:**');
          sections.push('```');
          sections.push(issue.snippet);
          sections.push('```');
        }
        sections.push('');
      }
    }

    const noIssuesMessage =
      scoredIssues.length === 0 && advisoryIssues.length === 0 && knownDebtIssues.length === 0
        ? '\n\n> ✅ Nenhum problema encontrado. Excelente trabalho!\n'
        : scoredIssues.length === 0
          ? '\n\n> ✅ Nenhum problema com impacto na nota foi encontrado.\n'
          : '';

    return [
      `## 🤖 CodeReviewer — Análise Automática`,
      '',
      `**Nota: ${score}/100** ${indicator}`,
      '',
      '---',
      '',
      ...sections,
      noIssuesMessage,
      '---',
      `*Gerado por CodeReviewer Bot em ${new Date().toISOString()}*`,
    ].join('\n');
  }

  formatFailureComment(prNumber: number, error: string): string {
    return [
      `## 🤖 CodeReviewer — Análise Automática`,
      '',
      `> ❌ A análise do PR #${prNumber} falhou.`,
      `> **Erro:** ${error}`,
      '',
      '*Por favor, verifique os logs do sistema.*',
    ].join('\n');
  }
}
