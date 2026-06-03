export interface RetryOptions {
  maxAttempts: number;
  delays: number[];
  retryOn?: (err: unknown) => boolean;
  onFinalFailure?: (err: unknown) => Promise<void>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxAttempts, delays, retryOn, onFinalFailure } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const shouldRetry = retryOn ? retryOn(err) : true;
      if (!shouldRetry) {
        if (onFinalFailure) await onFinalFailure(err);
        throw err;
      }

      if (attempt < maxAttempts - 1) {
        const delay = delays[attempt] ?? delays[delays.length - 1];
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  if (onFinalFailure) await onFinalFailure(lastError);
  throw lastError;
}
