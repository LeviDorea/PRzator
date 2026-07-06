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

/**
 * Invisible marker identifying the bot's managed analysis comment for
 * upserts. Never rendered by GitHub, so the visible header can change
 * freely without breaking comment updates.
 */
export const MANAGED_ANALYSIS_COMMENT_MARKER = '<!-- przator:analysis -->';

@Injectable()
export class CommentService {
  private readonly ALERT_TYPES: Record<CommentIssue['criticality'], string> = {
    high: 'CAUTION',
    medium: 'WARNING',
    low: 'NOTE',
  };

  formatMarkdown(data: CommentData): string {
    const { score, issues, generalIssues = [] } = data;
    const scoredIssues = issues.filter((issue) => !issue.advisory);
    const advisoryIssues = issues.filter((issue) => issue.advisory);

    const highCount = scoredIssues.filter((i) => i.criticality === 'high').length;
    const mediumCount = scoredIssues.filter((i) => i.criticality === 'medium').length;
    const lowCount = scoredIssues.filter((i) => i.criticality === 'low').length;

    const countBadges = [
      this.badge('Alta', String(highCount), highCount > 0 ? 'da3633' : GRAY),
      this.badge('Média', String(mediumCount), mediumCount > 0 ? 'd4a72c' : GRAY),
      this.badge('Baixa', String(lowCount), lowCount > 0 ? '388bfd' : GRAY),
    ].join(' ');
    const badges = `${this.badge('Nota', `${score}/100`, this.scoreColor(score))}&nbsp;&nbsp;&nbsp;&nbsp;${countBadges}`;

    const sections: string[] = [];

    const orderedScoredIssues = (['high', 'medium', 'low'] as const).flatMap((level) =>
      scoredIssues.filter((i) => i.criticality === level),
    );

    for (const issue of orderedScoredIssues) {
      sections.push(this.renderAlert(issue));
      sections.push('');
    }

    const secondarySections: string[] = [];

    if (advisoryIssues.length > 0) {
      secondarySections.push(
        this.renderCollapsedSection(
          'Outros problemas',
          'além do limite que conta para a nota',
          advisoryIssues,
        ),
      );
    }

    if (generalIssues.length > 0) {
      secondarySections.push(
        this.renderCollapsedSection('Sugestões gerais', 'fora das regras do repositório', generalIssues),
      );
    }

    if (secondarySections.length > 0) {
      sections.push('<sub>ℹ️ As seções abaixo são informativas e **não alteram a nota**.</sub>');
      sections.push('');
      sections.push(secondarySections.join('\n\n'));
    }

    if (scoredIssues.length === 0) {
      const allClear = advisoryIssues.length === 0 && generalIssues.length === 0;
      // Blank line first: without it the alert that follows a </details>
      // block is not recognised by GitHub and renders as literal text.
      sections.push('');
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
      MANAGED_ANALYSIS_COMMENT_MARKER,
      '## PRzator · Análise automática',
      '',
      badges,
      '',
      ...sections,
      `<sub>Gerado por PRzator Bot · ${this.formatTimestamp(new Date())}</sub>`,
    ].join('\n');
  }

  private badge(label: string, message: string, color: string): string {
    const encode = (value: string) => encodeURIComponent(value).replace(/-/g, '--');
    // Raw <img> instead of markdown image: GitHub wraps markdown images in a
    // link to the image URL, making the badge clickable; plain HTML is not.
    return `<img alt="${label}" src="https://img.shields.io/badge/${encode(label)}-${encode(message)}-${color}">`;
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

  private renderCollapsedSection(
    title: string,
    subtitle: string,
    sectionIssues: CommentIssue[],
  ): string {
    const items = sectionIssues.map((issue) => this.renderFlatItem(issue)).join('\n\n');
    return [
      '<details>',
      `<summary><strong>${title}</strong> <sub>· ${subtitle} · ${sectionIssues.length}</sub></summary>`,
      '',
      items,
      '',
      '</details>',
    ].join('\n');
  }

  private renderFlatItem(issue: CommentIssue): string {
    let block = `**\`${issue.file}\`** — ${issue.description}`;
    if (issue.reason) {
      block += `<br><sub>${issue.reason}</sub>`;
    }
    if (issue.snippet) {
      const language = detectLanguageFromFilename(issue.file) ?? '';
      block += `\n\n\`\`\`${language}\n${issue.snippet}\n\`\`\``;
    }
    return block;
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
      '## PRzator · Análise automática',
      '',
      '> [!CAUTION]',
      `> A análise do PR #${prNumber} falhou.`,
      `> **Erro:** ${error}`,
      '',
      '*Por favor, verifique os logs do sistema.*',
    ].join('\n');
  }
}
