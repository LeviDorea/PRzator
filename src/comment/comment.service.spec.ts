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
