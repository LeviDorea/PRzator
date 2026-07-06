import { Injectable } from '@nestjs/common';
import { GeneralIssue, ReviewIssue } from '../analysis/review-issue.types';
import { detectLanguageFromFilename } from '../common/utils/file-language.util';

export interface CommentData {
  score: number;
  prTitle: string;
  issues: ReviewIssue[];
  generalIssues?: GeneralIssue[];
}

type CommentIssue = Pick<
  ReviewIssue,
  'file' | 'snippet' | 'description' | 'reason' | 'criticality'
> & {
  rule?: string;
  baselineStatus?: ReviewIssue['baselineStatus'];
};

const GRAY = '484f58';

@Injectable()
export class CommentService {
  private readonly ALERT_TYPES: Record<CommentIssue['criticality'], string> = {
    high: 'CAUTION',
    medium: 'WARNING',
    low: 'NOTE',
  };

  formatMarkdown(data: CommentData): string {
    const { score, issues, generalIssues = [] } = data;
    const knownDebtIssues = issues.filter((issue) => issue.baselineStatus === 'known_debt');
    const scoredIssues = issues.filter(
      (issue) => !issue.advisory && issue.baselineStatus !== 'known_debt',
    );
    const advisoryIssues = issues.filter(
      (issue) => issue.advisory && issue.baselineStatus !== 'known_debt',
    );

    const highCount = scoredIssues.filter((i) => i.criticality === 'high').length;
    const mediumCount = scoredIssues.filter((i) => i.criticality === 'medium').length;
    const lowCount = scoredIssues.filter((i) => i.criticality === 'low').length;

    const badges = [
      this.badge('Nota', `${score}/100`, this.scoreColor(score)),
      this.badge('Alta', String(highCount), highCount > 0 ? 'da3633' : GRAY),
      this.badge('Média', String(mediumCount), mediumCount > 0 ? 'd4a72c' : GRAY),
      this.badge('Baixa', String(lowCount), lowCount > 0 ? '388bfd' : GRAY),
      this.badge('Dívida', String(knownDebtIssues.length), knownDebtIssues.length > 0 ? 'db6d28' : GRAY),
    ].join(' ');

    const sections: string[] = [];

    const orderedScoredIssues = (['high', 'medium', 'low'] as const).flatMap((level) =>
      scoredIssues.filter((i) => i.criticality === level),
    );

    for (const issue of orderedScoredIssues) {
      sections.push(this.renderAlert(issue));
      sections.push('');
    }

    if (knownDebtIssues.length > 0) {
      sections.push(this.renderSection('Dívida técnica conhecida', knownDebtIssues));
    }

    if (advisoryIssues.length > 0) {
      sections.push(this.renderCollapsedSection('Observações adicionais', advisoryIssues));
    }

    if (generalIssues.length > 0) {
      sections.push(this.renderCollapsedSection('Achados gerais', generalIssues));
    }

    if (scoredIssues.length === 0) {
      const allClear =
        knownDebtIssues.length === 0 && advisoryIssues.length === 0 && generalIssues.length === 0;
      sections.push(
        [
          '> [!TIP]',
          allClear
            ? '> Nenhum problema encontrado. Excelente trabalho!'
            : '> Nenhum problema com impacto na nota foi encontrado.',
        ].join('\n'),
      );
      sections.push('');
    }

    return [
      '## 🤖 PRzator · Análise automática',
      '',
      badges,
      '',
      ...sections,
      `<sub>Gerado por PRzator Bot · ${this.formatTimestamp(new Date())}</sub>`,
    ].join('\n');
  }

  private badge(label: string, message: string, color: string): string {
    const encode = (value: string) => encodeURIComponent(value).replace(/-/g, '--');
    return `![${label}](https://img.shields.io/badge/${encode(label)}-${encode(message)}-${color})`;
  }

  private scoreColor(score: number): string {
    if (score >= 80) return '3fb950';
    if (score >= 50) return 'd4a72c';
    return 'da3633';
  }

  private renderAlert(issue: CommentIssue): string {
    const statusLabel =
      issue.baselineStatus === 'new'
        ? 'novo neste commit'
        : issue.baselineStatus === 'persistent'
          ? 'persistente'
          : null;

    const lines: string[] = [`> [!${this.ALERT_TYPES[issue.criticality]}]`];
    const title = issue.rule
      ? `> **${issue.rule}** em \`${issue.file}\`${statusLabel ? ` · _${statusLabel}_` : ''}`
      : `> **${issue.description}**`;
    lines.push(title);
    lines.push(`> ${issue.reason}`);

    if (issue.snippet) {
      const language = detectLanguageFromFilename(issue.file) ?? '';
      lines.push('>');
      lines.push(`> \`\`\`${language}`);
      for (const snippetLine of issue.snippet.split('\n')) {
        lines.push(`> ${snippetLine}`);
      }
      lines.push('> ```');
    }

    return lines.join('\n');
  }

  private renderSection(title: string, sectionIssues: CommentIssue[]): string {
    const lines: string[] = [`### ${title} <sub>— não afeta a nota</sub>`, ''];
    for (const issue of sectionIssues) {
      lines.push(this.renderDetailsItem(issue));
      lines.push('');
    }
    return lines.join('\n');
  }

  private renderCollapsedSection(title: string, sectionIssues: CommentIssue[]): string {
    const lines: string[] = [
      '<details>',
      `<summary><strong>${title}</strong> <sub>— não afeta a nota</sub></summary>`,
      '',
    ];
    for (const issue of sectionIssues) {
      lines.push(this.renderDetailsItem(issue));
      lines.push('');
    }
    lines.push('</details>');
    return lines.join('\n');
  }

  private renderDetailsItem(issue: CommentIssue): string {
    const lines: string[] = [];
    lines.push('<details>');
    lines.push(`<summary><code>${issue.file}</code> — ${issue.description}</summary>`);
    lines.push('');
    lines.push(issue.reason);
    if (issue.snippet) {
      const language = detectLanguageFromFilename(issue.file) ?? '';
      lines.push('');
      lines.push('```' + language);
      lines.push(issue.snippet);
      lines.push('```');
    }
    lines.push('');
    lines.push('</details>');
    return lines.join('\n');
  }

  private formatTimestamp(date: Date): string {
    return date.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  formatFailureComment(prNumber: number, error: string): string {
    return [
      '## 🤖 PRzator · Análise automática',
      '',
      '> [!CAUTION]',
      `> A análise do PR #${prNumber} falhou.`,
      `> **Erro:** ${error}`,
      '',
      '*Por favor, verifique os logs do sistema.*',
    ].join('\n');
  }
}
