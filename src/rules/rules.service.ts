import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { AssociateReposDto } from './dto/associate-repos.dto';

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

  async getActiveRulesForRepo(repositoryId: string) {
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

    return [...defaultRules, ...globalCustomRules, ...repoSpecificRules];
  }

  private async findOrThrow(id: string) {
    const rule = await this.prisma.rule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Rule not found');
    return rule;
  }
}
