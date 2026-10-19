import { APICallError, InvalidPromptError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { PoolExhaustedError, classifyError } from '../src/errors.js';

const api = (statusCode: number | undefined) =>
  new APICallError({
    message: 'x',
    url: 'https://example.com',
    requestBodyValues: {},
    ...(statusCode === undefined ? {} : { statusCode }),
    isRetryable: true,
  });
const ctx = { callerAborted: false, timedOut: false };

describe('classifyError', () => {
  it('classifies HTTP failures', () => {
    expect(classifyError(api(429), ctx)).toBe('rate-limit');
    expect(classifyError(api(500), ctx)).toBe('retryable');
    expect(classifyError(api(503), ctx)).toBe('retryable');
    expect(classifyError(api(401), ctx)).toBe('retryable');
    expect(classifyError(api(402), ctx)).toBe('retryable');
    expect(classifyError(api(400), ctx)).toBe('fatal');
    expect(classifyError(api(422), ctx)).toBe('fatal');
    expect(classifyError(api(undefined), ctx)).toBe('retryable');
  });

  it('classifies aborts, timeouts and other errors', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyError(abort, { callerAborted: true, timedOut: false })).toBe('fatal');
    expect(classifyError(abort, { callerAborted: false, timedOut: true })).toBe('retryable');
    expect(classifyError(abort, ctx)).toBe('fatal');
    expect(classifyError(new InvalidPromptError({ prompt: '', message: 'bad' }), ctx)).toBe('fatal');
    expect(classifyError(new TypeError('fetch failed'), ctx)).toBe('retryable');
    expect(classifyError('weird', ctx)).toBe('retryable');
  });
});

describe('PoolExhaustedError', () => {
  it('summarises the failures', () => {
    const cause = new Error('last');
    const e = new PoolExhaustedError([{ memberId: 'a', reason: 'quota', retryAfterMs: 5 }], 5, cause);
    expect(e.message).toBe('All pool members are unavailable: a (quota)');
    expect(e.cause).toBe(cause);
    expect(e.retryAfterMs).toBe(5);
    expect(e.name).toBe('PoolExhaustedError');
    const empty = new PoolExhaustedError([], undefined);
    expect(empty.message).toContain('no members matched');
    expect(empty.cause).toBeUndefined();
  });
});
