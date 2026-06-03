import { withRetry, RetryOptions } from './retry.util';

const ZERO_DELAYS = [0, 0, 0, 0, 0];

describe('withRetry', () => {
  it('should return result on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, delays: ZERO_DELAYS });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed on 3rd attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxAttempts: 3, delays: ZERO_DELAYS });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after exhausting all attempts', async () => {
    const err = new Error('permanent failure');
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { maxAttempts: 3, delays: ZERO_DELAYS }),
    ).rejects.toThrow('permanent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should call onFinalFailure after exhausting attempts', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    const onFinalFailure = jest.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        delays: ZERO_DELAYS,
        onFinalFailure,
      }),
    ).rejects.toThrow();

    expect(onFinalFailure).toHaveBeenCalledTimes(1);
    expect(onFinalFailure).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should fail immediately when retryOn predicate returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('auth error'));
    const onFinalFailure = jest.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        delays: ZERO_DELAYS,
        retryOn: () => false,
        onFinalFailure,
      }),
    ).rejects.toThrow('auth error');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });

  it('should retry only when retryOn predicate returns true', async () => {
    const retryableError = Object.assign(new Error('timeout'), {
      status: 429,
    });
    const fn = jest
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      delays: ZERO_DELAYS,
      retryOn: (err: any) => err?.status === 429,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not call onFinalFailure when retryOn returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('non-retryable'));
    const onFinalFailure = jest.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        delays: ZERO_DELAYS,
        retryOn: () => false,
        onFinalFailure,
      }),
    ).rejects.toThrow();

    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });
});
