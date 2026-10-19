import { APICallError } from '@ai-sdk/provider';

/**
 * - `rate-limit`: cool the member down, try the next one.
 * - `retryable`: server error, network error, timeout, or a problem with this member
 *   only (bad key, no credits, model gone): try the next one.
 * - `fatal`: the request itself is wrong, or the caller gave up: rethrow.
 */
export type FailureKind = 'rate-limit' | 'retryable' | 'fatal';

const FATAL_STATUS = new Set([400, 422]);
const FATAL_SDK_ERRORS = new Set(['AI_InvalidPromptError', 'AI_InvalidArgumentError']);

export function classifyError(error: unknown, ctx: { callerAborted: boolean; timedOut: boolean }): FailureKind {
  if (ctx.callerAborted) return 'fatal';
  if (ctx.timedOut) return 'retryable';
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 429) return 'rate-limit';
    if (status !== undefined && FATAL_STATUS.has(status)) return 'fatal';
    return 'retryable';
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'fatal';
    if (FATAL_SDK_ERRORS.has(error.name)) return 'fatal';
  }
  return 'retryable';
}

export interface MemberFailure {
  memberId: string;
  reason: string;
  retryAfterMs?: number;
}

/** Every member was skipped or failed. */
export class PoolExhaustedError extends Error {
  override readonly name = 'PoolExhaustedError';

  constructor(
    readonly failures: MemberFailure[],
    /** The soonest any member frees up, if known. */
    readonly retryAfterMs: number | undefined,
    readonly lastError?: unknown,
  ) {
    super(
      `All pool members are unavailable: ${failures.map((f) => `${f.memberId} (${f.reason})`).join(', ') || 'no members matched'}`,
      lastError === undefined ? undefined : { cause: lastError },
    );
  }
}
