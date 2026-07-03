import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  detectLanguageFromFilename,
  normalizeLanguage,
  normalizePath,
} from '../src/common/utils/file-language.util';

type Criticality = 'low' | 'medium' | 'high';
type ReviewStatus = 'approved' | 'approved_with_adjustment';

interface ApprovedRule {
  id: string;
  sourceRepo: string;
  title: string;
  description: string;
  criticality: Criticality;
  fileGlobs: string[];
  targetLanguage?: string | null;
  reviewStatus: ReviewStatus;
  adjustmentNotes?: string;
  classification?: string;
  confidence?: string;
}

interface ApprovedRulesFile {
  generatedAt: string;
  notes?: string;
  rules: ApprovedRule[];
  discardedRules?: Record<string, unknown>;
}

interface ImportRuleDto {
  title: string;
  description: string;
  criticality: Criticality;
  fileGlobs: string[];
  targetLanguage?: string;
}

interface PreparedRule {
  sourceId: string;
  sourceRepo: string;
  reviewStatus: ReviewStatus;
  adjustmentNotes?: string;
  classification?: string;
  confidence?: string;
  targetLanguageOriginal: string | null;
  targetLanguageNormalized: string | null;
  normalizationNotes: string[];
  importRule: ImportRuleDto;
}

interface ImportManifest {
  generatedAt: string;
  sourceArtifact: string;
  totalRules: number;
  rules: PreparedRule[];
}

interface RepoResolution {
  id: string;
  name: string;
  fullName: string;
}

interface RuleValidationResult {
  matchCount: number;
  sampleMatches: string[];
}

const MODE = process.argv[2] ?? 'dry-run';
const CODEREVIEWER_ROOT = process.cwd();
const WORKSPACE_ROOT = path.resolve(CODEREVIEWER_ROOT, '..');
const APPROVED_RULES_PATH =
  process.env.APPROVED_RULES_PATH ??
  path.join(WORKSPACE_ROOT, 'codereviewer-approved-rules.json');
const IMPORT_RULES_PATH =
  process.env.IMPORT_RULES_PATH ??
  path.join(WORKSPACE_ROOT, 'codereviewer-import-rules.json');
const IMPORT_MANIFEST_PATH =
  process.env.IMPORT_MANIFEST_PATH ??
  path.join(WORKSPACE_ROOT, 'codereviewer-import-manifest.json');
const LOCAL_REPOS_ROOT =
  process.env.LOCAL_REPOS_ROOT ?? '/home/elevia/ProjetosElevia';

const repoTrackedFilesCache = new Map<string, string[]>();

async function main() {
  if (!['prepare', 'dry-run', 'import'].includes(MODE)) {
    throw new Error(
      `Unsupported mode "${MODE}". Use prepare, dry-run, or import.`,
    );
  }

  const approvedRules = await readApprovedRules(APPROVED_RULES_PATH);
  const manifest = buildManifest(approvedRules);

  await writePreparedArtifacts(manifest);

  if (MODE === 'prepare') {
    printPreparationSummary(manifest);
    return;
  }

  const dryRunResult = await runDryRun(manifest);
  printDryRunSummary(dryRunResult);

  if (MODE === 'import') {
    await importPreparedRules(manifest, dryRunResult.repoResolutions);
  }
}

async function readApprovedRules(filePath: string): Promise<ApprovedRulesFile> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as ApprovedRulesFile;
}

function buildManifest(approvedRules: ApprovedRulesFile): ImportManifest {
  const rules = approvedRules.rules.map((rule) => prepareRule(rule));

  return {
    generatedAt: new Date().toISOString(),
    sourceArtifact: APPROVED_RULES_PATH,
    totalRules: rules.length,
    rules,
  };
}

function prepareRule(rule: ApprovedRule): PreparedRule {
  const normalizedFileGlobs = Array.from(
    new Set((rule.fileGlobs ?? []).map((glob) => normalizePath(glob))),
  );
  const expandedFileGlobs = Array.from(
    new Set(normalizedFileGlobs.flatMap((glob) => expandGlobVariants(glob))),
  );
  const {
    normalizedTargetLanguage,
    normalizationNotes,
  } = normalizeTargetLanguage(rule.targetLanguage ?? null, expandedFileGlobs);

  const importRule: ImportRuleDto = {
    title: rule.title,
    description: rule.description,
    criticality: rule.criticality,
    fileGlobs: expandedFileGlobs,
    ...(normalizedTargetLanguage
      ? { targetLanguage: normalizedTargetLanguage }
      : {}),
  };

  return {
    sourceId: rule.id,
    sourceRepo: rule.sourceRepo,
    reviewStatus: rule.reviewStatus,
    adjustmentNotes: rule.adjustmentNotes,
    classification: rule.classification,
    confidence: rule.confidence,
    targetLanguageOriginal: rule.targetLanguage ?? null,
    targetLanguageNormalized: normalizedTargetLanguage,
    normalizationNotes,
    importRule,
  };
}

function normalizeTargetLanguage(
  targetLanguage: string | null,
  fileGlobs: string[],
): {
  normalizedTargetLanguage: string | null;
  normalizationNotes: string[];
} {
  if (!targetLanguage) {
    return {
      normalizedTargetLanguage: null,
      normalizationNotes: [],
    };
  }

  const normalizedTargetLanguage = normalizeLanguage(targetLanguage);
  const normalizationNotes: string[] = [];

  if (
    normalizedTargetLanguage === 'mixed' ||
    normalizedTargetLanguage === 'configuration'
  ) {
    return { normalizedTargetLanguage, normalizationNotes };
  }

  const globLanguages = Array.from(
    new Set(
      fileGlobs
        .map((glob) => inferGlobLanguage(glob))
        .filter((language): language is string => Boolean(language)),
    ),
  );
  const mismatchedGlobLanguages = globLanguages.filter(
    (language) => language !== normalizedTargetLanguage,
  );

  if (mismatchedGlobLanguages.length > 0) {
    normalizationNotes.push(
      `targetLanguage normalized to mixed because fileGlobs span ${[
        normalizedTargetLanguage,
        ...mismatchedGlobLanguages,
      ].join(', ')}`,
    );
    return {
      normalizedTargetLanguage: 'mixed',
      normalizationNotes,
    };
  }

  return { normalizedTargetLanguage, normalizationNotes };
}

function inferGlobLanguage(glob: string): string | null {
  const normalizedGlob = normalizePath(glob);
  const basename = normalizedGlob.split('/').pop() ?? normalizedGlob;
  const basenameLower = basename.toLowerCase();

  if (basenameLower === 'dockerfile' || basenameLower.startsWith('dockerfile.')) {
    return 'dockerfile';
  }

  if (basenameLower === '.env' || basenameLower.startsWith('.env.')) {
    return 'env';
  }

  if (basenameLower.endsWith('.sh')) {
    return 'shell';
  }

  if (basenameLower.endsWith('.sql')) {
    return 'sql';
  }

  return detectLanguageFromFilename(basename);
}

async function writePreparedArtifacts(manifest: ImportManifest) {
  await mkdir(path.dirname(IMPORT_RULES_PATH), { recursive: true });

  const importRules = manifest.rules.map((rule) => rule.importRule);

  await writeJson(IMPORT_RULES_PATH, importRules);
  await writeJson(IMPORT_MANIFEST_PATH, manifest);
}

async function runDryRun(manifest: ImportManifest) {
  const repoResolutions = await tryResolveRepositories(manifest.rules);
  const validationByRule = new Map<string, RuleValidationResult>();

  for (const rule of manifest.rules) {
    validationByRule.set(
      rule.sourceId,
      validateRuleAgainstRepo(rule, rule.sourceRepo),
    );
  }

  return {
    repoResolutions,
    validationByRule,
  };
}

async function tryResolveRepositories(rules: PreparedRule[]) {
  const sourceRepos = Array.from(new Set(rules.map((rule) => rule.sourceRepo)));

  if (!process.env.DATABASE_URL) {
    return {
      enabled: false as const,
      resolved: new Map<string, RepoResolution>(),
      unresolved: sourceRepos,
      error: 'DATABASE_URL not configured',
    };
  }

  const prisma = new PrismaClient();

  try {
    const repositories = await prisma.repository.findMany({
      select: { id: true, name: true, fullName: true },
    });
    const resolved = new Map<string, RepoResolution>();
    const unresolved: string[] = [];

    for (const sourceRepo of sourceRepos) {
      const matches = repositories.filter(
        (repo) =>
          repo.name === sourceRepo ||
          repo.fullName === sourceRepo ||
          repo.fullName.endsWith(`/${sourceRepo}`),
      );

      if (matches.length === 1) {
        resolved.set(sourceRepo, matches[0]);
      } else {
        unresolved.push(sourceRepo);
      }
    }

    return {
      enabled: true as const,
      resolved,
      unresolved,
      error: null,
    };
  } catch (error) {
    return {
      enabled: true as const,
      resolved: new Map<string, RepoResolution>(),
      unresolved: sourceRepos,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await prisma.$disconnect();
  }
}

function validateRuleAgainstRepo(
  rule: PreparedRule,
  sourceRepo: string,
): RuleValidationResult {
  const repoPath = path.join(LOCAL_REPOS_ROOT, sourceRepo);

  if (!existsSync(repoPath)) {
    return { matchCount: 0, sampleMatches: [] };
  }

  const trackedFiles = getTrackedFiles(repoPath);
  const matches = trackedFiles.filter((filename) =>
    ruleMatchesFile(rule.importRule, filename),
  );

  return {
    matchCount: matches.length,
    sampleMatches: matches.slice(0, 3),
  };
}

function getTrackedFiles(repoPath: string): string[] {
  const cached = repoTrackedFilesCache.get(repoPath);
  if (cached) {
    return cached;
  }

  const output = execFileSync('git', ['-C', repoPath, 'ls-files'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const trackedFiles = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  repoTrackedFilesCache.set(repoPath, trackedFiles);
  return trackedFiles;
}

function ruleMatchesFile(rule: ImportRuleDto, filename: string): boolean {
  if (!matchesFileGlobs(rule.fileGlobs, filename)) {
    return false;
  }

  return matchesLanguage(
    rule.targetLanguage ?? null,
    detectLanguageFromFilename(filename),
  );
}

function matchesFileGlobs(fileGlobs: string[], filename: string): boolean {
  if (!fileGlobs || fileGlobs.length === 0) {
    return true;
  }

  const candidatePaths = buildFilenameCandidates(filename);

  return fileGlobs.some((glob) =>
    expandGlobVariants(normalizePath(glob)).some((variant) =>
      candidatePaths.some((candidatePath) =>
        globToRegExp(variant).test(candidatePath),
      ),
    ),
  );
}

function matchesLanguage(
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

function buildFilenameCandidates(filename: string): string[] {
  const normalizedFilename = normalizePath(filename);
  const candidates = new Set<string>([normalizedFilename]);

  if (normalizedFilename.startsWith('php/')) {
    candidates.add(normalizedFilename.slice('php/'.length));
  }

  return Array.from(candidates);
}

function globToRegExp(glob: string): RegExp {
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

function expandGlobVariants(glob: string): string[] {
  const braceMatch = glob.match(/\{([^{}]+)\}/);
  if (!braceMatch) {
    return [glob];
  }

  const [token, content] = braceMatch;
  return content
    .split(',')
    .map((variant) => variant.trim())
    .flatMap((variant) => expandGlobVariants(glob.replace(token, variant)));
}

async function importPreparedRules(
  manifest: ImportManifest,
  repoResolutions: Awaited<ReturnType<typeof tryResolveRepositories>>,
) {
  if (!repoResolutions.enabled) {
    throw new Error(
      'Import requires DATABASE_URL so repository associations can be resolved.',
    );
  }

  if (repoResolutions.unresolved.length > 0) {
    throw new Error(
      `Import aborted because some repositories could not be resolved: ${repoResolutions.unresolved.join(
        ', ',
      )}`,
    );
  }

  const prisma = new PrismaClient();
  let created = 0;
  let reused = 0;
  let associationsCreated = 0;

  try {
    for (const rule of manifest.rules) {
      const repo = repoResolutions.resolved.get(rule.sourceRepo);
      if (!repo) {
        throw new Error(`Repository mapping missing for ${rule.sourceRepo}`);
      }

      const existingRules = await prisma.rule.findMany({
        where: {
          isDefault: false,
          title: rule.importRule.title,
          description: rule.importRule.description,
        },
        include: { ruleRepos: true },
      });

      const exactMatch = existingRules.find((existingRule) =>
        sameImportPayload(existingRule, rule.importRule),
      );

      const persistedRule =
        exactMatch ??
        (await prisma.rule.create({
          data: {
            title: rule.importRule.title,
            description: rule.importRule.description,
            criticality: rule.importRule.criticality,
            fileGlobs: rule.importRule.fileGlobs,
            targetLanguage: rule.importRule.targetLanguage ?? null,
          },
        }));

      if (exactMatch) {
        reused += 1;
      } else {
        created += 1;
      }

      const existingAssociation = await prisma.ruleRepository.findUnique({
        where: {
          ruleId_repositoryId: {
            ruleId: persistedRule.id,
            repositoryId: repo.id,
          },
        },
      });

      if (!existingAssociation) {
        await prisma.ruleRepository.create({
          data: {
            ruleId: persistedRule.id,
            repositoryId: repo.id,
          },
        });
        associationsCreated += 1;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `Import complete: created ${created}, reused ${reused}, new associations ${associationsCreated}.`,
  );
}

function sameImportPayload(
  existingRule: {
    title: string;
    description: string;
    criticality: Criticality;
    fileGlobs: string[];
    targetLanguage: string | null;
  },
  importRule: ImportRuleDto,
): boolean {
  const existingFileGlobs = Array.from(
    new Set(existingRule.fileGlobs.map((glob) => normalizePath(glob))),
  );
  const importFileGlobs = Array.from(
    new Set(importRule.fileGlobs.map((glob) => normalizePath(glob))),
  );

  return (
    existingRule.title === importRule.title &&
    existingRule.description === importRule.description &&
    existingRule.criticality === importRule.criticality &&
    (existingRule.targetLanguage ?? null) === (importRule.targetLanguage ?? null) &&
    JSON.stringify(existingFileGlobs) === JSON.stringify(importFileGlobs)
  );
}

function printPreparationSummary(manifest: ImportManifest) {
  const normalizedRules = manifest.rules.filter(
    (rule) => rule.normalizationNotes.length > 0,
  );

  console.log(`Prepared ${manifest.totalRules} approved rules.`);
  console.log(`Import JSON: ${IMPORT_RULES_PATH}`);
  console.log(`Import manifest: ${IMPORT_MANIFEST_PATH}`);
  console.log(`Rules with normalization notes: ${normalizedRules.length}`);
}

function printDryRunSummary(dryRunResult: {
  repoResolutions: Awaited<ReturnType<typeof tryResolveRepositories>>;
  validationByRule: Map<string, RuleValidationResult>;
}) {
  const deadRules = Array.from(dryRunResult.validationByRule.entries()).filter(
    ([, result]) => result.matchCount === 0,
  );

  console.log(`Prepared import files:`);
  console.log(`- ${IMPORT_RULES_PATH}`);
  console.log(`- ${IMPORT_MANIFEST_PATH}`);

  if (dryRunResult.repoResolutions.enabled) {
    console.log(
      `Repository resolution: ${dryRunResult.repoResolutions.resolved.size} resolved, ${dryRunResult.repoResolutions.unresolved.length} unresolved.`,
    );
    if (dryRunResult.repoResolutions.error) {
      console.log(
        `Repository resolution error: ${dryRunResult.repoResolutions.error}`,
      );
    }
    if (dryRunResult.repoResolutions.unresolved.length > 0) {
      console.log(
        `Unresolved repositories: ${dryRunResult.repoResolutions.unresolved.join(', ')}`,
      );
    }
  } else {
    console.log(
      `Repository resolution skipped: ${dryRunResult.repoResolutions.error}`,
    );
  }

  console.log(
    `File-match validation: ${dryRunResult.validationByRule.size - deadRules.length} rules matched tracked files, ${deadRules.length} rules matched none.`,
  );

  if (deadRules.length > 0) {
    console.log('Rules with zero tracked-file matches:');
    for (const [ruleId] of deadRules) {
      console.log(`- ${ruleId}`);
    }
  }
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
