import { Module } from '@nestjs/common';
import { ScoringConfigController } from './scoring-config.controller';
import { ScoringConfigService } from './scoring-config.service';

@Module({
  controllers: [ScoringConfigController],
  providers: [ScoringConfigService],
  exports: [ScoringConfigService],
})
export class ScoringConfigModule {}
