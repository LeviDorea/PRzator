import {
  detectLanguageFromFilename,
  normalizeLanguage,
} from './file-language.util';

describe('file-language.util', () => {
  describe('normalizeLanguage', () => {
    it('should normalize supported aliases', () => {
      expect(normalizeLanguage('SQL')).toBe('sql');
      expect(normalizeLanguage('Sh')).toBe('shell');
      expect(normalizeLanguage('YML')).toBe('yaml');
    });
  });

  describe('detectLanguageFromFilename', () => {
    it('should detect non-standard config and infra filenames', () => {
      expect(detectLanguageFromFilename('database-image/sql/schema.sql')).toBe(
        'sql',
      );
      expect(detectLanguageFromFilename('aws/secrets.sh')).toBe('shell');
      expect(detectLanguageFromFilename('Dockerfile')).toBe('dockerfile');
      expect(detectLanguageFromFilename('Dockerfile.dev')).toBe('dockerfile');
      expect(detectLanguageFromFilename('.env.example')).toBe('env');
    });
  });
});
