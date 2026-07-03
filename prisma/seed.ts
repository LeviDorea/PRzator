import 'dotenv/config';
import { PrismaClient, Criticality } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_RULES = [
  {
    title: 'Secret Exposure',
    description:
      'A hardcoded secret, token, password, or private key was added directly in source code. ' +
      'Secrets must be read from environment variables or a secrets manager. ' +
      'Bad: `const apiKey = "sk-abc123"`. Good: `const apiKey = process.env.API_KEY`.',
    criticality: Criticality.high,
    isDefault: true,
  },
  {
    title: 'SQL Injection Risk',
    description:
      'User-controlled input is concatenated directly into a raw SQL query without parameterization. ' +
      'Use parameterized queries or the ORM query builder instead. ' +
      'Bad: `"SELECT * FROM users WHERE id = " + userId`. ' +
      'Good: `db.query("SELECT * FROM users WHERE id = ?", [userId])`.',
    criticality: Criticality.high,
    isDefault: true,
  },
  {
    title: 'Business Logic Outside Model Layer',
    description:
      'A conditional, calculation, or status transition that belongs to the domain was added inside a controller, ' +
      'route handler, or view instead of a model or service. ' +
      'Controllers should orchestrate request/response flow and delegate domain decisions. ' +
      'Report this issue, cite the rule, and state which model or service should own the logic.',
    criticality: Criticality.high,
    isDefault: true,
    fileGlobs: [
      'app/Controller/**/*.php',
      'src/Controller/**/*.php',
      'app/Http/Controllers/**/*.php',
      '**/routes/**/*.php',
      'src/**/*controller*',
      'src/**/*Controller*',
    ],
  },
  {
    title: 'Duplicated Database Query',
    description:
      'A database query was added that duplicates an existing model method or performs the same lookup already ' +
      'present elsewhere in the codebase. Reuse or extend the existing method instead of adding a new ad hoc query. ' +
      'Report only when the duplication is visible within the diff or its immediate context.',
    criticality: Criticality.medium,
    isDefault: true,
    fileGlobs: [
      '**/*.php',
      '**/*.py',
      '**/*.ts',
    ],
  },
  {
    title: 'N+1 Query Pattern',
    description:
      'A database query is executed inside a loop, causing one query per iteration instead of a single batched query. ' +
      'Bad: `for (const id of ids) { await db.find(id) }`. ' +
      'Good: `await db.findMany({ where: { id: { in: ids } } })`.',
    criticality: Criticality.medium,
    isDefault: true,
    fileGlobs: [
      '**/*.php',
      '**/*.py',
      '**/*.ts',
    ],
  },
  {
    title: 'CakePHP 2 File/Class Naming Mismatch',
    description:
      'In CakePHP 2, the filename must exactly match the class name including case. A mismatch causes silent load failures. ' +
      'Bad: file `emailSender.php` containing `class EmailSender`. ' +
      'Good: file `EmailSender.php` containing `class EmailSender`.',
    criticality: Criticality.high,
    isDefault: true,
    fileGlobs: [
      'app/Controller/**/*.php',
      'app/Model/**/*.php',
      'app/Lib/**/*.php',
      'app/Controller/Component/**/*.php',
    ],
  },
  {
    title: 'CakePHP 2 Undeclared $uses or $components',
    description:
      'A Model or Component is used inside a CakePHP 2 controller without being declared in $uses or $components. ' +
      'This causes a fatal error at runtime. ' +
      'Bad: calling `$this->Payment->save()` without `public $uses = ["Payment"]`. ' +
      'Good: declare every Model in `$uses` and every Component in `$components` before using them.',
    criticality: Criticality.high,
    isDefault: true,
    fileGlobs: [
      'app/Controller/**/*.php',
    ],
  },
  {
    title: 'Mautic array_filter Prohibition',
    description:
      'array_filter() must never be used on Mautic contact payloads. It silently removes falsy values (0, false, "") ' +
      'from the payload, causing fields to be unset on the contact instead of updated. ' +
      'Remove any array_filter() call that wraps or processes data sent to Mautic.',
    criticality: Criticality.high,
    isDefault: true,
    fileGlobs: [
      '**/*.php',
    ],
  },
  {
    title: 'planos.valor Must Store Monthly Equivalent Only',
    description:
      'The planos.valor column stores only the monthly equivalent value, never the total for the billing cycle. ' +
      'Any code that writes a quarterly, semi-annual, or annual total directly to planos.valor is incorrect. ' +
      'Convert to the monthly equivalent before persisting.',
    criticality: Criticality.high,
    isDefault: true,
    fileGlobs: [
      '**/*.php',
      '**/*.py',
    ],
  },
  {
    title: 'planos Table Requires Raw SQL for ALTER',
    description:
      'The planos table contains legacy zero-date values that cause Phinx schema builder methods to fail silently or error. ' +
      'Any migration that alters the planos table must use raw SQL via $this->execute() instead of Phinx builder methods ' +
      'such as changeColumn() or addColumn().',
    criticality: Criticality.high,
    isDefault: true,
    fileGlobs: [
      '**/migrations/**/*.php',
      '**/Migrations/**/*.php',
    ],
  },
];

async function main() {
  console.log('Seeding default rules...');

  const existingDefaultCount = await prisma.rule.count({
    where: { isDefault: true },
  });

  if (existingDefaultCount === 0) {
    await prisma.rule.createMany({ data: DEFAULT_RULES });
    console.log(`Seeded ${DEFAULT_RULES.length} default rules.`);
  } else {
    console.log(
      `Default rules already exist (${existingDefaultCount}), skipping.`,
    );
  }

  const existingConfig = await prisma.scoringConfig.findFirst();
  if (!existingConfig) {
    await prisma.scoringConfig.create({
      data: { high: 10, medium: 4, low: 1 },
    });
    console.log('Seeded initial ScoringConfig.');
  } else {
    console.log('ScoringConfig already exists, skipping.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
