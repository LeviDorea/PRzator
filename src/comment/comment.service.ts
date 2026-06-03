import { Injectable } from '@nestjs/common';

export interface CommentIssue {
  file: string;
  snippet: string;
  description: string;
  reason: string;
  criticality: 'high' | 'medium' | 'low';
  rule: string;
}

export interface CommentData {
  score: number;
  prTitle: string;
  issues: CommentIssue[];
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

    const sections: string[] = [];

    for (const level of ['high', 'medium', 'low'] as const) {
      const levelIssues = issues.filter((i) => i.criticality === level);
      if (levelIssues.length === 0) continue;

      const icon = this.ICONS[level];
      const label = this.LABELS[level];

      sections.push(`### ${icon} ${label} (${levelIssues.length} problema${levelIssues.length > 1 ? 's' : ''})`);
      sections.push('');

      for (const issue of levelIssues) {
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
      issues.length === 0
        ? '\n\n> ✅ Nenhum problema encontrado. Excelente trabalho!\n'
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
