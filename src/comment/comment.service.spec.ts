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
    it('should include the score and indicator', () => {
      const result = svc.formatMarkdown({ score: 85, prTitle: 'PR', issues: [] });
      expect(result).toContain('85/100');
      expect(result).toContain('✅');
    });

    it('should show warning indicator for score between 50 and 79', () => {
      const result = svc.formatMarkdown({ score: 65, prTitle: 'PR', issues: [] });
      expect(result).toContain('⚠️');
    });

    it('should show failure indicator for score below 50', () => {
      const result = svc.formatMarkdown({ score: 30, prTitle: 'PR', issues: [] });
      expect(result).toContain('❌');
    });

    it('should include no-issues message when issues array is empty', () => {
      const result = svc.formatMarkdown({ score: 100, prTitle: 'PR', issues: [] });
      expect(result).toContain('Nenhum problema encontrado');
    });

    it('should group issues by criticality with correct icons', () => {
      const result = svc.formatMarkdown({
        score: 75,
        prTitle: 'PR',
        issues: [HIGH_ISSUE, LOW_ISSUE],
      });
      expect(result).toContain('🔴 Alta Criticidade');
      expect(result).toContain('🟢 Baixa Criticidade');
      expect(result).not.toContain('🟡 Média Criticidade');
    });

    it('should include file reference and rule name', () => {
      const result = svc.formatMarkdown({ score: 90, prTitle: 'PR', issues: [HIGH_ISSUE] });
      expect(result).toContain('src/auth.ts');
      expect(result).toContain('Security');
      expect(result).toContain('Hardcoded secret');
    });

    it('should include code snippet when provided', () => {
      const result = svc.formatMarkdown({ score: 90, prTitle: 'PR', issues: [HIGH_ISSUE] });
      expect(result).toContain('const secret = "hardcoded"');
    });

    it('should not include code block when snippet is empty', () => {
      const result = svc.formatMarkdown({ score: 99, prTitle: 'PR', issues: [LOW_ISSUE] });
      expect(result).toContain('Missing error handling');
    });

    it('should render advisory issues in a separate section without affecting the score section', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [PERSISTENT_ISSUE, ADVISORY_ISSUE],
      });

      expect(result).toContain('Hardcoded secret');
      expect(result).toContain('Persistente');
      expect(result).toContain('Observações Adicionais');
      expect(result).toContain('Extra documentation suggestion');
      expect(result).toContain('sem impacto na nota');
    });

    it('should not say no issues found when only advisories exist', () => {
      const result = svc.formatMarkdown({
        score: 100,
        prTitle: 'PR',
        issues: [ADVISORY_ISSUE],
      });

      expect(result).toContain('Nenhum problema com impacto na nota foi encontrado');
      expect(result).not.toContain('Nenhum problema encontrado. Excelente trabalho!');
    });

    it('should render known debt in a separate section outside the scored issues', () => {
      const result = svc.formatMarkdown({
        score: 90,
        prTitle: 'PR',
        issues: [NEW_ISSUE, KNOWN_DEBT_ISSUE],
      });

      expect(result).toContain('Nova neste commit');
      expect(result).toContain('Known Debt');
      expect(result).toContain('Preexistente / descoberto agora');
      expect(result).toContain('Legacy issue');
    });
  });

  describe('formatFailureComment', () => {
    it('should include error message and PR number', () => {
      const result = svc.formatFailureComment(42, 'timeout error');
      expect(result).toContain('#42');
      expect(result).toContain('timeout error');
      expect(result).toContain('❌');
    });
  });
});
