import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AnalysisService } from './analysis.service';
import { ANALYSIS_REQUESTED } from '../common/events/analysis.events';
import type { AnalysisRequestedEvent } from '../common/events/analysis.events';

/**
 * Serializes analysis runs per PR (repositoryId + prNumber) and coalesces
 * events that arrive while a run is already in flight: only the latest one
 * is kept and processed next, avoiding wasted/racy analyses on commits that
 * have already been superseded. Single-process only — does not coordinate
 * across multiple app instances.
 */
@Injectable()
export class AnalysisListener {
  private readonly logger = new Logger(AnalysisListener.name);
  private readonly inFlight = new Set<string>();
  private readonly pending = new Map<string, AnalysisRequestedEvent>();

  constructor(private readonly analysisService: AnalysisService) {}

  @OnEvent(ANALYSIS_REQUESTED, { async: true })
  async handleAnalysisRequested(event: AnalysisRequestedEvent): Promise<void> {
    const key = this.keyFor(event);

    if (this.inFlight.has(key)) {
      this.logger.log(
        `Analysis already in flight for ${key}; superseding with commit ${event.commitSha}`,
      );
      this.pending.set(key, event);
      return;
    }

    await this.runAndDrain(key, event);
  }

  private async runAndDrain(key: string, event: AnalysisRequestedEvent): Promise<void> {
    this.inFlight.add(key);
    try {
      await this.analysisService.runPipeline(event);
    } finally {
      this.inFlight.delete(key);
    }

    const next = this.pending.get(key);
    if (next) {
      this.pending.delete(key);
      await this.runAndDrain(key, next);
    }
  }

  private keyFor(event: AnalysisRequestedEvent): string {
    return `${event.repositoryId}:${event.prNumber}`;
  }
}
