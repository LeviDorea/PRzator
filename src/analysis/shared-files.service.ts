import { Injectable, Logger } from '@nestjs/common';
import { GithubService } from '../github/github.service';

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  javascript: [
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [
    /^from\s+([\w.]+)\s+import/gm,
    /^import\s+([\w.]+)/gm,
  ],
};

@Injectable()
export class SharedFilesService {
  private readonly logger = new Logger(SharedFilesService.name);

  constructor(private readonly github: GithubService) {}

  extractRelativeImports(content: string, language: string): string[] {
    const patterns = IMPORT_PATTERNS[language.toLowerCase()] ?? [];
    const imports = new Set<string>();

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath && (importPath.startsWith('./') || importPath.startsWith('../'))) {
          imports.add(importPath);
        }
      }
    }

    return Array.from(imports);
  }

  async fetchSharedFilesContext(
    owner: string,
    repo: string,
    installationId: number,
    changedFiles: Array<{ filename: string; patch: string }>,
    primaryLanguage: string,
  ): Promise<string> {
    const sharedPaths = new Set<string>();

    for (const file of changedFiles) {
      const imports = this.extractRelativeImports(file.patch, primaryLanguage);
      for (const imp of imports) {
        const resolved = this.resolveImportPath(file.filename, imp);
        if (resolved) sharedPaths.add(resolved);
      }
    }

    const contents: string[] = [];
    for (const path of sharedPaths) {
      try {
        const content = await this.github.getFileContent(owner, repo, path, installationId);
        if (content) {
          contents.push(`// File: ${path}\n${content}`);
        }
      } catch (e) {
        this.logger.warn(`Could not fetch shared file: ${path}`);
      }
    }

    return contents.join('\n\n---\n\n');
  }

  private resolveImportPath(fromFile: string, importPath: string): string | null {
    const parts = fromFile.split('/');
    parts.pop();
    const resolved = [...parts, ...importPath.split('/')].reduce(
      (acc: string[], part) => {
        if (part === '..') acc.pop();
        else if (part !== '.') acc.push(part);
        return acc;
      },
      [],
    );
    const candidate = resolved.join('/');
    return candidate || null;
  }
}
