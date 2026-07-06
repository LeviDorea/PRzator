import { AnalysisListener } from './analysis.listener';
import type { AnalysisRequestedEvent } from '../common/events/analysis.events';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeEvent(overrides: Partial<AnalysisRequestedEvent> = {}): AnalysisRequestedEvent {
  return {
    owner: 'org',
    repo: 'repo',
    prNumber: 1,
    prTitle: 'Fix bug',
    prBody: 'details',
    baseSha: 'base456',
    commitSha: 'abc123',
    installationId: 42,
    repositoryId: 'repo-db-id',
    ...overrides,
  };
}

describe('AnalysisListener', () => {
  let runPipeline: jest.Mock;
  let listener: AnalysisListener;

  beforeEach(() => {
    runPipeline = jest.fn();
    listener = new AnalysisListener({ runPipeline } as any);
  });

  it('runs the pipeline once for a single event', async () => {
    runPipeline.mockResolvedValue(undefined);
    const event = makeEvent();

    await listener.handleAnalysisRequested(event);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(event);
  });

  it('coalesces an event that arrives while the same PR is in flight, running only the latest afterwards', async () => {
    const first = deferred();
    runPipeline.mockImplementationOnce(() => first.promise);
    runPipeline.mockImplementationOnce(() => Promise.resolve());

    const eventA = makeEvent({ commitSha: 'commitA' });
    const eventB = makeEvent({ commitSha: 'commitB' });

    const runA = listener.handleAnalysisRequested(eventA);
    // eventB arrives while A is still in flight
    const runB = listener.handleAnalysisRequested(eventB);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(eventA);

    first.resolve();
    await Promise.all([runA, runB]);

    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(runPipeline).toHaveBeenNthCalledWith(2, eventB);
  });

  it('drops intermediate events, keeping only the most recent one queued behind an in-flight run', async () => {
    const first = deferred();
    runPipeline.mockImplementationOnce(() => first.promise);
    runPipeline.mockImplementationOnce(() => Promise.resolve());

    const eventA = makeEvent({ commitSha: 'commitA' });
    const eventB = makeEvent({ commitSha: 'commitB' });
    const eventC = makeEvent({ commitSha: 'commitC' });

    const runA = listener.handleAnalysisRequested(eventA);
    await listener.handleAnalysisRequested(eventB);
    const runC = listener.handleAnalysisRequested(eventC);

    first.resolve();
    await Promise.all([runA, runC]);

    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(runPipeline).toHaveBeenNthCalledWith(1, eventA);
    expect(runPipeline).toHaveBeenNthCalledWith(2, eventC);
  });

  it('processes different PRs concurrently without blocking each other', async () => {
    const first = deferred();
    runPipeline.mockImplementationOnce(() => first.promise);
    runPipeline.mockImplementationOnce(() => Promise.resolve());

    const eventPr1 = makeEvent({ prNumber: 1, commitSha: 'commitA' });
    const eventPr2 = makeEvent({ prNumber: 2, commitSha: 'commitB' });

    const run1 = listener.handleAnalysisRequested(eventPr1);
    const run2 = listener.handleAnalysisRequested(eventPr2);

    expect(runPipeline).toHaveBeenCalledTimes(2);

    first.resolve();
    await Promise.all([run1, run2]);
  });
});
