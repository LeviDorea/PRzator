import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ScoringConfigService } from './scoring-config.service';
import { UpdateScoringConfigDto } from './dto/update-scoring-config.dto';
import { BasicAuthGuard } from '../auth/basic-auth.guard';

@Controller('config/scoring')
@UseGuards(BasicAuthGuard)
export class ScoringConfigController {
  constructor(private readonly service: ScoringConfigService) {}

  @Get()
  findOne() {
    return this.service.findOne();
  }

  @Put()
  update(@Body() dto: UpdateScoringConfigDto) {
    return this.service.update(dto);
  }
}
