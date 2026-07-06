import { CommentService } from './comment.service';

const HIGH_ISSUE = {
  file: 'src/auth.ts',
  snippet: 'const secret = "hardcoded"',
  description: 'Hardcoded secret',
  reason: 'Exposes credentials',
  criticality: 'high' as const,
  rule: 'Security',
};

const LOW_ISSUE = {
  file: 'src/app.ts',
  snippet: '',
  description: 'Missing error handling',
  reason: 'May cause unhandled exceptions',
  criticality: 'low' as const,
  rule: 'Boas Práticas',
};
const ADVISORY_ISSUE = {
  file: 'src/docs.md',
  snippet: '',
  description: 'Extra documentation suggestion',
  reason: 'Outside the per-run cap',
  criticality: 'low' as const,
  rule: 'Boas Práticas',
  advisory: true,
};
const PERSISTENT_ISSUE = {
  ...HIGH_ISSUE,
  baselineStatus: 'persistent' as const,
};
const NEW_ISSUE = {
  ...LOW_ISSUE,
  baselineStatus: 'new' as const,
};

describe('CommentService', () => {
  const svc = new CommentService();

  describe('formatMarkdown', () => {
    it('should include the score badge with the green color for a high score', () => {
      const result = svc.formatMarkdown({ score: 85, prTitle: 'PR', issues: [] });
      expect(result).toContain('Nota-85%2F100-3fb950');
    });

    it('should show the amber score badge for a score between 50 and 79', () => {
      const result = svc.formatMarkdown({ score: 65, prTitle: 'PR', issues: [] });
      expect(result).toContain('Nota-65%2F100-d4a72c');
    });

    it('should show the red score badge for a score below 50', () => {
      const result = svc.formatMarkdown({ score: 30, prTitle: 'PR', issues: [] });
      expect(result).toContain('Nota-30%2F100-da3633');
    });

    it('should include a gray badge for severities with zero issues', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result).toContain('Alta-0-484f58');
      expect(result).toContain('M%C3%A9dia-0-484f58');
      expect(result).toContain('Baixa-0-484f58');
    });

    it('should not include a Dívida badge (known debt is out of scope)', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result).not.toContain('D%C3%ADvida');
    });

    it('should include a tip alert when issues array is empty', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result).toContain('> [!TIP]');
      expect(result).toContain('Nenhum problema encontrado');
    });

    it('should keep a blank line before the tip alert so GitHub renders it after </details>', () => {
      const result = svc.formatMarkdown({
        score: 100,
        prTitle: 'PR',
        issues: [],
        generalIssues: [
          {
            file: 'src/app.ts',
            snippet: '',
            description: 'Sugestão',
            reason: '',
            criticality: 'low' as const,
            issueKey: 'g1',
          },
        ],
      });
      expect(result).toContain('</details>\n\n> [!TIP]');
    });

    it('should start with the invisible managed-comment marker and drop the emoji header', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result.startsWith('<!-- przator:analysis -->')).toBe(true);
      expect(result).toContain('## PRzator · Análise automática');
      expect(result).not.toContain('🤖');
    });

    it('should render badges as plain img tags with a wider gap after the score', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result).toContain('<img alt="Nota"');
      expect(result).not.toContain('![Nota]');
      expect(result).toContain('&nbsp;&nbsp;&nbsp;&nbsp;<img alt="Alta"');
    });

    it('should render each scored issue as a native GitHub alert, ordered by criticality', () => {
      const result = svc.formatMarkdown({
        score: 75,
        prTitle: 'PR',
        issues: [LOW_ISSUE, HIGH_ISSUE],
      });

      expect(result).toContain('> [!CAUTION]');
      expect(result).toContain('> [!NOTE]');
      expect(result.indexOf('[!CAUTION]')).toBeLessThan(result.indexOf('[!NOTE]'));
      expect(result).toContain('Alta-1-da3633');
      expect(result).toContain('Baixa-1-388bfd');
    });

    it('should use a warning alert for medium criticality issues', () => {
      const result = svc.formatMarkdown({
        score: 80,
        prTitle: 'PR',
        issues: [{ ...HIGH_ISSUE, criticality: 'medium' as const }],
      });
      expect(result).toContain('> [!WARNING]');
    });

    it('should include file reference and rule name in the alert', () => {
      const result = svc.formatMarkdown({ score: 90, prTitle: 'PR', issues: [HIGH_ISSUE] });
      expect(result).toContain('`src/auth.ts`');
      expect(result).toContain('**Security**');
      expect(result).toContain('Exposes credentials');
    });

    it('should include code snippet in a blockquoted fence when provided', () => {
      const result = svc.formatMarkdown({ score: 90, prTitle: 'PR', issues: [HIGH_ISSUE] });
      expect(result).toContain('> const secret = "hardcoded"');
      expect(result).toContain('> ```');
    });

    it('should not include a code block when snippet is empty', () => {
      const result = svc.formatMarkdown({ score: 99, prTitle: 'PR', issues: [LOW_ISSUE] });
      expect(result).toContain('May cause unhandled exceptions');
    });

    it('should mark new and persistent issues in the alert title', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [PERSISTENT_ISSUE, NEW_ISSUE],
      });

      expect(result).toContain('_persistente_');
      expect(result).toContain('_novo neste commit_');
    });

    it('should render advisory issues in one collapsed section with flat items (no nested details)', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [PERSISTENT_ISSUE, ADVISORY_ISSUE],
      });

      expect(result).toContain(
        '<summary><strong>Outros problemas</strong> <sub>· além do limite que conta para a nota · 1</sub></summary>',
      );
      expect(result).toContain('**`src/docs.md`** — Extra documentation suggestion');
      expect(result).toContain('<sub>Outside the per-run cap</sub>');
      // no nested per-item <details>/<summary><code> inside the section
      expect(result).not.toContain('<summary><code>');
    });

    it('should render the legend line above the informational sections', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [PERSISTENT_ISSUE, ADVISORY_ISSUE],
      });

      expect(result).toContain(
        '<sub>ℹ️ As seções abaixo são informativas e **não alteram a nota**.</sub>',
      );
    });

    it('should render general issues in one collapsed section', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [],
        generalIssues: [
          {
            file: 'src/pedido.php',
            snippet: '',
            description: 'Robustez',
            reason: 'strtotime pode retornar false',
            criticality: 'medium',
            issueKey: 'key-1',
          },
        ],
      });

      expect(result).toContain(
        '<summary><strong>Sugestões gerais</strong> <sub>· fora das regras do repositório · 1</sub></summary>',
      );
      expect(result).toContain('**`src/pedido.php`** — Robustez');
    });
  });

  describe('formatFailureComment', () => {
    it('should include error message, PR number, and a caution alert', () => {
      const result = svc.formatFailureComment(42, 'timeout error');
      expect(result).toContain('#42');
      expect(result).toContain('timeout error');
      expect(result).toContain('> [!CAUTION]');
    });
  });
});
