import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Rule, RuleScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { AssociateReposDto } from './dto/associate-repos.dto';
import {
  detectLanguageFromFilename,
  normalizeLanguage,
  normalizePath,
} from '../common/utils/file-language.util';

export interface RulePromptContext {
  title: string;
  description: string;
  criticality: 'low' | 'medium' | 'high';
  scope?: RuleScope;
  whyThisRuleExists?: string | null;
  localEvidence?: string[];
}

export interface FileRulesContext {
  filename: string;
  language: string | null;
  rules: RulePromptContext[];
}

export interface ActiveRulesContext {
  files: FileRulesContext[];
  prRules: RulePromptContext[];
  contextPaths: string[];
}

@Injectable()
export class RulesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.rule.findMany({ orderBy: { createdAt: 'asc' } });
  }

  create(dto: CreateRuleDto) {
    return this.prisma.rule.create({ data: dto });
  }

  async update(id: string, dto: UpdateRuleDto) {
    const rule = await this.findOrThrow(id);
    if (rule.isDefault) {
      throw new ForbiddenException('Default rules cannot be modified');
    }
    return this.prisma.rule.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    const rule = await this.findOrThrow(id);
    if (rule.isDefault) {
      throw new ForbiddenException('Default rules cannot be deleted');
    }
    return this.prisma.rule.delete({ where: { id } });
  }

  async associateToRepos(id: string, dto: AssociateReposDto) {
    await this.findOrThrow(id);

    await this.prisma.ruleRepository.deleteMany({ where: { ruleId: id } });

    if (dto.repositoryIds.length > 0) {
      await this.prisma.ruleRepository.createMany({
        data: dto.repositoryIds.map((repositoryId) => ({
          ruleId: id,
          repositoryId,
        })),
        skipDuplicates: true,
      });
    }

    return this.prisma.rule.findUnique({
      where: { id },
      include: { ruleRepos: true },
    });
  }

  async getActiveRulesForRepo(
    repositoryId: string,
    changedFiles: Array<{ filename: string }>,
  ): Promise<ActiveRulesContext> {
    const activeRules = await this.listActiveRulesForRepo(repositoryId);
    const matchedRules = activeRules.filter((rule) =>
      changedFiles.some((file) => this.ruleMatchesFile(rule, file.filename)),
    );
    const prRules = matchedRules
      .filter((rule) => rule.scope === RuleScope.pr)
      .map((rule) => this.toPromptContext(rule));

    const files = changedFiles.map((file) => {
      const language = detectLanguageFromFilename(file.filename);
      const rules = activeRules
        .filter((rule) => rule.scope !== RuleScope.pr)
        .filter((rule) => this.ruleMatchesFile(rule, file.filename))
        .map((rule) => this.toPromptContext(rule));

      return {
        filename: file.filename,
        language,
        rules,
      };
    });

    const contextPaths = Array.from(
      new Set(
        [...files.flatMap((file) => file.rules), ...prRules]
          .flatMap((rule) => rule.localEvidence ?? [])
          .map((path) => normalizePath(path))
          .filter(Boolean),
      ),
    );

    return {
      files,
      prRules,
      contextPaths,
    };
  }

  private async listActiveRulesForRepo(repositoryId: string) {
    const [defaultRules, globalCustomRules, repoSpecificRules] =
      await Promise.all([
        this.prisma.rule.findMany({ where: { isDefault: true } }),
        this.prisma.rule.findMany({
          where: { isDefault: false, ruleRepos: { none: {} } },
        }),
        this.prisma.rule.findMany({
          where: {
            isDefault: false,
            ruleRepos: { some: { repositoryId } },
          },
        }),
      ]);

    const customRules = [...globalCustomRules, ...repoSpecificRules];
    const supersededDefaultTitles = new Set(
      customRules.flatMap((rule) => rule.supersedesDefaults ?? []),
    );
    const activeDefaultRules = defaultRules.filter(
      (rule) => !supersededDefaultTitles.has(rule.title),
    );

    return [...activeDefaultRules, ...customRules];
  }

  private ruleMatchesFile(
    rule: Pick<Rule, 'fileGlobs' | 'targetLanguage'>,
    filename: string,
  ): boolean {
    const detectedLanguage = detectLanguageFromFilename(filename);

    if (!this.matchesFile(rule, filename)) {
      return false;
    }

    return this.matchesLanguage(rule.targetLanguage, detectedLanguage);
  }

  private matchesFile(rule: Pick<Rule, 'fileGlobs'>, filename: string): boolean {
    if (!rule.fileGlobs || rule.fileGlobs.length === 0) {
      return true;
    }

    const candidatePaths = this.buildFilenameCandidates(filename);
    return rule.fileGlobs.some((glob) =>
      this.expandGlobVariants(normalizePath(glob)).some((variant) =>
        candidatePaths.some((candidatePath) =>
          this.globToRegExp(variant).test(candidatePath),
        ),
      ),
    );
  }

  private matchesLanguage(
    targetLanguage: string | null,
    detectedLanguage: string | null,
  ): boolean {
    if (!targetLanguage) {
      return true;
    }

    const normalizedTargetLanguage = normalizeLanguage(targetLanguage);
    if (
      normalizedTargetLanguage === 'mixed' ||
      normalizedTargetLanguage === 'configuration'
    ) {
      return true;
    }

    if (!detectedLanguage) {
      return false;
    }

    return normalizedTargetLanguage === detectedLanguage;
  }

  private globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const globstarDirToken = '__GLOBSTAR_DIR__';
    const globstarToken = '__GLOBSTAR__';
    const pattern = escaped
      .replace(/\*\*\//g, globstarDirToken)
      .replace(/\*\*/g, globstarToken)
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(new RegExp(globstarDirToken, 'g'), '(?:.*/)?')
      .replace(new RegExp(globstarToken, 'g'), '.*');

    return new RegExp(`^${pattern}$`);
  }

  private expandGlobVariants(glob: string): string[] {
    const braceMatch = glob.match(/\{([^{}]+)\}/);
    if (!braceMatch) {
      return [glob];
    }

    const [token, content] = braceMatch;
    return content
      .split(',')
      .map((variant) => variant.trim())
      .flatMap((variant) =>
        this.expandGlobVariants(glob.replace(token, variant)),
      );
  }

  private buildFilenameCandidates(filename: string): string[] {
    const normalizedFilename = normalizePath(filename);
    const candidates = new Set<string>([normalizedFilename]);

    // Some legacy PHP repos are mounted with a leading "php/" workspace root,
    // while rules are authored against the application root ("app/...").
    if (normalizedFilename.startsWith('php/')) {
      candidates.add(normalizedFilename.slice('php/'.length));
    }

    return Array.from(candidates);
  }

  private toPromptContext(
    rule: Pick<
      Rule,
      'title' | 'description' | 'criticality' | 'scope' | 'whyThisRuleExists' | 'localEvidence'
    >,
  ): RulePromptContext {
    return {
      title: rule.title,
      description: rule.description,
      criticality: rule.criticality,
      scope: rule.scope,
      whyThisRuleExists: rule.whyThisRuleExists ?? null,
      localEvidence: rule.localEvidence ?? [],
    };
  }

  private async findOrThrow(id: string) {
    const rule = await this.prisma.rule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Rule not found');
    return rule;
  }
}
