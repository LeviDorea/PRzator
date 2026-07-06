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
const KNOWN_DEBT_ISSUE = {
  file: 'src/legacy.ts',
  snippet: 'legacyProblem()',
  description: 'Legacy issue',
  reason: 'Pre-existing debt',
  criticality: 'medium' as const,
  rule: 'Boas Práticas',
  baselineStatus: 'known_debt' as const,
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
      expect(result).toContain('D%C3%ADvida-0-484f58');
    });

    it('should include a tip alert when issues array is empty', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result).toContain('> [!TIP]');
      expect(result).toContain('Nenhum problema encontrado');
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

    it('should render advisory issues collapsed under one section toggle, with per-item details nested inside', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [PERSISTENT_ISSUE, ADVISORY_ISSUE],
      });

      expect(result).toContain(
        '<summary><strong>Observações adicionais</strong> <sub>— não afeta a nota</sub></summary>',
      );
      expect(result).toContain('<summary><code>src/docs.md</code> — Extra documentation suggestion</summary>');
    });

    it('should render known debt under its own heading, outside the scored alerts', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [NEW_ISSUE, KNOWN_DEBT_ISSUE],
      });

      expect(result).toContain('### Dívida técnica conhecida <sub>— não afeta a nota</sub>');
      expect(result).toContain('<summary><code>src/legacy.ts</code> — Legacy issue</summary>');
      expect(result).toContain('Pre-existing debt');
      expect(result).toContain('D%C3%ADvida-1-db6d28');
    });

    it('should render general issues collapsed under one section toggle', () => {
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
        '<summary><strong>Achados gerais</strong> <sub>— não afeta a nota</sub></summary>',
      );
      expect(result).toContain('<summary><code>src/pedido.php</code> — Robustez</summary>');
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
