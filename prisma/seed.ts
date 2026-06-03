import 'dotenv/config';
import { PrismaClient, Criticality } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_RULES = [
  {
    title: 'Segurança',
    description:
      'Verificar exposição de segredos, injeção de código, OWASP Top 10 e outras vulnerabilidades de segurança.',
    criticality: Criticality.high,
    isDefault: true,
  },
  {
    title: 'Ambiguidade',
    description:
      'Identificar nomes genéricos, lógica confusa, ausência de tipagem adequada e código de difícil compreensão.',
    criticality: Criticality.medium,
    isDefault: true,
  },
  {
    title: 'Duplicidade de Código',
    description:
      'Detectar violações do princípio DRY (Do not Repeat Yourself), lógica duplicada e oportunidades de reuso.',
    criticality: Criticality.medium,
    isDefault: true,
  },
  {
    title: 'Arquitetura e SOLID',
    description:
      'Verificar aderência aos princípios SOLID (SRP, OCP, LSP, ISP, DIP), separação de responsabilidades em controllers, services e repositories.',
    criticality: Criticality.high,
    isDefault: true,
  },
  {
    title: 'Boas Práticas',
    description:
      'Avaliar tratamento de erros, logs, nomenclatura de variáveis/funções, estrutura de código e convenções da linguagem.',
    criticality: Criticality.low,
    isDefault: true,
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
