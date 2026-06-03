import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateScoringConfigDto } from './dto/update-scoring-config.dto';

@Injectable()
export class ScoringConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne() {
    const config = await this.prisma.scoringConfig.findFirst();
    if (!config) throw new NotFoundException('ScoringConfig not found');
    return config;
  }

  async update(dto: UpdateScoringConfigDto) {
    const config = await this.prisma.scoringConfig.findFirst();
    if (!config) throw new NotFoundException('ScoringConfig not found');
    return this.prisma.scoringConfig.update({
      where: { id: config.id },
      data: dto,
    });
  }
}
