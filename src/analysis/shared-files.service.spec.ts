import { SharedFilesService } from './shared-files.service';

const mockGithub = {
  getFileContent: jest.fn(),
};

function makeService() {
  return new SharedFilesService(mockGithub as any);
}

describe('SharedFilesService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('extractRelativeImports', () => {
    it('should extract relative TS imports', () => {
      const svc = makeService();
      const content = `
        import { Foo } from './foo';
        import { Bar } from '../bar/baz';
        import { Ext } from '@nestjs/common';
      `;
      const result = svc.extractRelativeImports(content, 'typescript');
      expect(result).toContain('./foo');
      expect(result).toContain('../bar/baz');
      expect(result).not.toContain('@nestjs/common');
    });

    it('should extract relative require calls', () => {
      const svc = makeService();
      const content = `const x = require('./utils/helper');`;
      const result = svc.extractRelativeImports(content, 'javascript');
      expect(result).toContain('./utils/helper');
    });

    it('should return empty array for unknown language', () => {
      const svc = makeService();
      const result = svc.extractRelativeImports("from foo import bar", 'go');
      expect(result).toEqual([]);
    });
  });

  describe('fetchSharedFilesContext', () => {
    it('should fetch and return content for relative imports', async () => {
      mockGithub.getFileContent.mockResolvedValue('export const x = 1;');
      const svc = makeService();

      const files = [{ filename: 'src/app.ts', patch: `import { x } from './utils';` }];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(mockGithub.getFileContent).toHaveBeenCalledWith('org', 'repo', 'src/utils', 1, 'sha123');
      expect(result).toContain('export const x = 1;');
      expect(result).toContain('Context only. Do not report standalone issues for this file.');
    });

    it('should skip files that fail to fetch', async () => {
      mockGithub.getFileContent.mockRejectedValue(new Error('not found'));
      const svc = makeService();

      const files = [{ filename: 'src/app.ts', patch: `import { x } from './missing';` }];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');
      expect(result).toBe('');
    });

    it('should return empty string when no relative imports found', async () => {
      const svc = makeService();
      const files = [{ filename: 'src/app.ts', patch: `import { Injectable } from '@nestjs/common';` }];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');
      expect(result).toBe('');
      expect(mockGithub.getFileContent).not.toHaveBeenCalled();
    });

    it('should detect language per file and skip unsupported extensions', async () => {
      mockGithub.getFileContent.mockResolvedValue('export const helper = true;');
      const svc = makeService();
      const files = [
        { filename: 'src/app.ts', patch: `import { helper } from './helper';` },
        { filename: 'assets/logo.svg', patch: `<svg></svg>` },
      ];

      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(result).toContain('export const helper = true;');
      expect(mockGithub.getFileContent).toHaveBeenCalledTimes(1);
    });
  });
});
