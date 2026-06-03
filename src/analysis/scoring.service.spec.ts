import { ScoringService } from './scoring.service';

const WEIGHTS = { high: 10, medium: 4, low: 1 };

describe('ScoringService', () => {
  const svc = new ScoringService();

  it('should return 100 when there are no issues', () => {
    expect(svc.calculate([], WEIGHTS)).toBe(100);
  });

  it('should deduct per criticality weight', () => {
    const issues = [
      { criticality: 'high' as const },
      { criticality: 'medium' as const },
      { criticality: 'low' as const },
    ];
    expect(svc.calculate(issues, WEIGHTS)).toBe(100 - 10 - 4 - 1);
  });

  it('should clamp score to 0 when deduction exceeds 100', () => {
    const issues = Array.from({ length: 15 }, () => ({ criticality: 'high' as const }));
    expect(svc.calculate(issues, WEIGHTS)).toBe(0);
  });

  it('should accumulate multiple issues of same criticality', () => {
    const issues = [
      { criticality: 'high' as const },
      { criticality: 'high' as const },
    ];
    expect(svc.calculate(issues, WEIGHTS)).toBe(80);
  });

  it('should use custom weights', () => {
    const customWeights = { high: 20, medium: 8, low: 2 };
    const issues = [{ criticality: 'high' as const }];
    expect(svc.calculate(issues, customWeights)).toBe(80);
  });
});
