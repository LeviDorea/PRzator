import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { BasicAuthGuard } from '../auth/basic-auth.guard';

@Controller('analyses')
@UseGuards(BasicAuthGuard)
export class AnalysisController {
  constructor(private readonly service: AnalysisService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get('repo/:repositoryId')
  findByRepository(@Param('repositoryId') repositoryId: string) {
    return this.service.findByRepository(repositoryId);
  }
}
