import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AnalysisService } from './analysis.service';
import { ANALYSIS_REQUESTED } from '../common/events/analysis.events';
import type { AnalysisRequestedEvent } from '../common/events/analysis.events';

@Injectable()
export class AnalysisListener {
  constructor(private readonly analysisService: AnalysisService) {}

  @OnEvent(ANALYSIS_REQUESTED, { async: true })
  async handleAnalysisRequested(event: AnalysisRequestedEvent): Promise<void> {
    await this.analysisService.runPipeline(event);
  }
}
