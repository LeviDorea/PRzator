import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { RulesModule } from '../rules/rules.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisListener } from './analysis.listener';
import { AnalysisService } from './analysis.service';
import { DiffService } from './diff.service';
import { LlmService } from './llm.service';
import { ScoringService } from './scoring.service';
import { SharedFilesService } from './shared-files.service';

@Module({
  imports: [GithubModule, RulesModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    AnalysisListener,
    DiffService,
    LlmService,
    ScoringService,
    SharedFilesService,
  ],
})
export class AnalysisModule {}
