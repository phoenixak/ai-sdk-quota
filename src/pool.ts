import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { systemClock } from './clock.js';
import { type MemberFailure, PoolExhaustedError, classifyError } from './errors.js';
import { type EstimateTokens, OutputEstimator, estimateInputTokens } from './estimate.js';
import { adapterFor } from './headers.js';
import { resolveGroup, resolveLimits } from './limits/index.js';
import { stripForeignProviderData } from './prompt-compat.js';
import { type ResolvedMember, type Strategy, headroom, selectMembers } from './select.js';
import { memoryStore } from './store/memory.js';
import type { Charge, QuotaStore, Reservation, Usage } from './store/types.js';
import { holdUntilFirstChunk } from './stream.js';
import type { Capabilities, Clock, Dimension, HeaderReading, Limits, PoolEvent, PoolMember, ProviderTruth } from './types.js';
import { DIMENSIONS, nextDayStart, windowSpec } from './windows.js';

export interface QuotaPoolOptions {
  models: PoolMember[];
  /** Defaults to `memoryStore()`, which is per process. Use a shared store on serverless. */
  store?: QuotaStore;
  /** Defaults to `'priority'` (the order of `models`). */
  strategy?: Strategy;
  /** Limits for shared groups; overrides the registry (e.g. `{ 'openrouter:free-daily': { rpd: 1000, ... } }`). */
  groups?: Record<string, Limits>;
  /** Limits per budget key (a user, tenant or IP), charged on top of provider limits. */
  budgets?: { perKey?: Limits };
  /** Give up on a streaming member that hasn't sent its first chunk by then. Not applied to the last candidate. Default 20s. */
  firstTokenTimeoutMs?: number;
  /** Unfinished reservations are released after this long. Default 5 minutes. */
  reservationTtlMs?: number;
  /** Typical reply size before real replies are seen. Default 512. */
  expectedOutputTokens?: number;
  estimateTokens?: EstimateTokens;
  /** Cooldown after a server error, timeout or member-specific failure. Default 15s. */
  failureCooldownMs?: number;
  /** Longest cooldown after repeated 429s without a retry hint. Default 60s. */
  maxBackoffMs?: number;
  /** How long a conversation sticks to its last member. Default 30 minutes. */
  stickyTtlMs?: number;
  /** Strip other providers' data from the prompt before calling a member. Default true. */
  stripForeignProviderData?: boolean;
  /**
   * Use this fraction of every provider limit (members and groups; not your budgets).
   * Providers count windows differently from a strict sliding window (Groq rejected
   * calls a 60s sliding count allowed when traffic was front-loaded), so a little
   * margin trades some throughput for fewer 429s. Default 1.
   */
  safetyMargin?: number;
  /**
   * Learn a provider's real rate from its 429s. When a 429 names a window, that
   * member's effective limit for the window drops to 75% (never below 25%), then
   * climbs back linearly to the configured limit over `recoverMs` (default 5 minutes).
   * Providers don't always allow their published rate (Groq sustained ~20 of a
   * published 30 RPM for one free account on 2026-10-19). Per process. `false` turns it off.
   */
  adaptive?: false | { recoverMs?: number };
  clock?: Clock;
  random?: () => number;
  onEvent?: (event: PoolEvent) => void;
}

export interface PoolModelOptions {
  /** Charges this call to a budget (see `budgets.perKey`). */
  budgetKey?: string;
  /** Only members that support these. Tools are required automatically when the call has tools. */
  require?: (keyof Capabilities)[];
  /** Skip members with any of these tags, e.g. `['may-train']` for private data. */
  exclude?: string[];
  /** Keep a conversation on the member that served it last, while that member has quota. */
  stickyKey?: string;
}

export interface MemberSnapshot {
  id: string;
  cooldownUntil: number;
  headroom: number;
  usage: Usage;
}

export interface PoolSnapshot {
  members: MemberSnapshot[];
  groups: { id: string; usage: Usage }[];
}

export interface QuotaPool {
  model(options?: PoolModelOptions): LanguageModelV4;
  snapshot(): Promise<PoolSnapshot>;
  /**
   * What is left of a budget key's limits (`budgets.perKey`), e.g. for
   * "you have 12 messages left today": `(await pool.remaining(userId)).rpd?.remaining`.
   */
  remaining(budgetKey: string): Promise<Usage>;
}

const DAY_MS = 86_400_000;

/**
 * A 429 that names its window means the provider counts it full, whatever we counted
 * (other processes, earlier runs, clock skew). Rolling windows drain over their length;
 * calendar days stay full until the next local midnight.
 */
function fullWindows(m: ResolvedMember, reading: HeaderReading, now: number): ProviderTruth[] {
  return (reading.limited ?? []).flatMap((dim): ProviderTruth[] => {
    if (m.limits[dim] === undefined) return [];
    const spec = windowSpec(dim, m.limits.dailyReset);
    return spec.kind === 'rolling'
      ? [{ dim, remaining: 0, resetInMs: spec.windowMs, drain: true }]
      : [{ dim, remaining: 0, resetInMs: nextDayStart(now, spec.timeZone) - now }];
  });
}

/** Tells the caller which member answered: `result.providerMetadata.aiSdkQuota.memberId`. */
function servedBy(m: ResolvedMember) {
  return { aiSdkQuota: { memberId: m.member.id, provider: m.member.model.provider, modelId: m.member.model.modelId } };
}

class FirstTokenTimeoutError extends Error {
  override readonly name = 'FirstTokenTimeoutError';
}

export function createQuotaPool(options: QuotaPoolOptions): QuotaPool {
  const store = options.store ?? memoryStore();
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const emit = (event: PoolEvent) => options.onEvent?.(event);
  const strategy = options.strategy ?? 'priority';
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 20_000;
  const ttlMs = options.reservationTtlMs ?? 300_000;
  const failureCooldownMs = options.failureCooldownMs ?? 15_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const stickyTtlMs = options.stickyTtlMs ?? 30 * 60_000;
  const strip = options.stripForeignProviderData ?? true;
  const estimateInput = options.estimateTokens ?? estimateInputTokens;
  const outputs = new OutputEstimator(options.expectedOutputTokens ?? 512);
  const rateLimitStreak = new Map<string, number>();
  const members = resolveMembers(options);
  const recoverMs = options.adaptive === false ? 0 : (options.adaptive?.recoverMs ?? 300_000);
  // memberId|dim -> the factor set by the last named 429, and when.
  const adapted = new Map<string, { factor: number; at: number }>();

  function factorFor(memberId: string, dim: Dimension, now: number): number {
    const a = adapted.get(`${memberId}|${dim}`);
    if (!a) return 1;
    const factor = Math.min(1, a.factor + ((now - a.at) / recoverMs) * (1 - a.factor));
    if (factor >= 1) adapted.delete(`${memberId}|${dim}`);
    return factor;
  }

  function effectiveLimits(m: ResolvedMember, now: number): Limits {
    if (!adapted.size) return m.limits;
    const out: Limits = { ...m.limits };
    for (const dim of DIMENSIONS) {
      const v = m.limits[dim];
      if (v !== undefined) out[dim] = Math.max(1, Math.floor(v * factorFor(m.member.id, dim, now)));
    }
    return out;
  }

  function adapt(m: ResolvedMember, reading: HeaderReading, now: number) {
    if (!recoverMs) return;
    for (const dim of reading.limited ?? []) {
      if (m.limits[dim] === undefined) continue;
      const factor = Math.max(0.25, factorFor(m.member.id, dim, now) * 0.75);
      adapted.set(`${m.member.id}|${dim}`, { factor, at: now });
      emit({ type: 'adapt', memberId: m.member.id, dim, factor });
    }
  }
  const groupIds = [...new Set(members.flatMap((m) => m.groups.map((g) => g.key)))];

  function charges(m: ResolvedMember, tokens: number, budgetKey: string | undefined): Charge[] {
    const list: Charge[] = [{ key: m.key, limits: effectiveLimits(m, clock.now()), requests: 1, tokens }];
    for (const g of m.groups) list.push({ key: g.key, limits: g.limits, requests: 1, tokens });
    if (budgetKey !== undefined && options.budgets?.perKey) {
      list.push({ key: `b:${budgetKey}`, limits: options.budgets.perKey, requests: 1, tokens });
    }
    return list;
  }

  async function applyReading(m: ResolvedMember, reading: HeaderReading, now: number) {
    if (reading.truths.length) await store.applyProviderTruth(m.key, effectiveLimits(m, now), reading.truths, now);
  }

  function totalTokens(usage: LanguageModelV4Usage | undefined): number | undefined {
    const input = usage?.inputTokens.total;
    const output = usage?.outputTokens.total;
    return input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0);
  }

  async function reconcile(m: ResolvedMember, reservation: Reservation, estimated: number, usage: LanguageModelV4Usage | undefined) {
    const actual = totalTokens(usage);
    const output = usage?.outputTokens.total;
    if (output !== undefined) outputs.observe(m.member.id, output);
    await store.commit(reservation, actual, clock.now());
    emit({ type: 'reconcile', memberId: m.member.id, estimatedTokens: estimated, actualTokens: actual });
  }

  async function cooldownAfter(m: ResolvedMember, kind: 'rate-limit' | 'retryable', reading: HeaderReading, now: number) {
    let until: number;
    if (kind === 'rate-limit') {
      const streak = (rateLimitStreak.get(m.member.id) ?? 0) + 1;
      rateLimitStreak.set(m.member.id, streak);
      if (reading.dailyExhausted) {
        const reset = m.limits.dailyReset;
        until = reset && reset !== 'rolling' ? nextDayStart(now, reset.timeZone) : now + DAY_MS;
      } else {
        until = now + (reading.retryAfterMs ?? Math.min(maxBackoffMs, 1_000 * 2 ** (streak - 1)));
      }
    } else {
      until = now + failureCooldownMs;
    }
    await store.setCooldown(m.member.id, until);
    emit({ type: 'cooldown', memberId: m.member.id, untilMs: until });
  }

  /**
   * Tries members in order until one accepts the call. `call` gets the member and the
   * call options to use, and returns once the member has committed to answering.
   */
  async function run<T>(
    callOptions: LanguageModelV4CallOptions,
    poolOptions: PoolModelOptions,
    call: (
      m: ResolvedMember,
      options: LanguageModelV4CallOptions,
      done: { reservation: Reservation; estimated: number; isLast: boolean },
    ) => Promise<{ value: T; headers: Record<string, string | undefined> | undefined }>,
  ): Promise<T> {
    const callerSignal = callOptions.abortSignal;
    const stickyMemberId =
      poolOptions.stickyKey === undefined ? undefined : await store.getSticky(poolOptions.stickyKey, clock.now());
    const require = [...(poolOptions.require ?? [])];
    if (callOptions.tools?.length && !require.includes('tools')) require.push('tools');
    const { ordered, skipped } = await selectMembers({
      members,
      store,
      now: clock.now(),
      strategy,
      random,
      require,
      exclude: poolOptions.exclude,
      stickyMemberId,
    });
    const failures: MemberFailure[] = [];
    for (const s of skipped) {
      emit({ type: 'skip', ...s });
      failures.push({ memberId: s.memberId, reason: s.reason, ...(s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs }) });
    }

    let lastError: unknown;
    for (const [attempt, m] of ordered.entries()) {
      const prompt = strip ? stripForeignProviderData(callOptions.prompt, m.member.model.provider) : callOptions.prompt;
      const options = { ...callOptions, prompt };
      const estimated = estimateInput(options) + outputs.expected(m.member.id, callOptions.maxOutputTokens);
      const reserved = await store.reserve(charges(m, estimated, poolOptions.budgetKey), { now: clock.now(), ttlMs });
      if (!reserved.ok) {
        const reason = reserved.retryAfterMs === Infinity ? 'never-fits' : 'quota';
        const retry = reserved.retryAfterMs === Infinity ? {} : { retryAfterMs: reserved.retryAfterMs };
        emit({ type: 'skip', memberId: m.member.id, reason, ...retry });
        failures.push({ memberId: m.member.id, reason, ...retry });
        continue;
      }
      const { reservation } = reserved;
      emit({ type: 'route', memberId: m.member.id, attempt, estimatedTokens: estimated });

      try {
        const { value, headers } = await call(m, options, {
          reservation,
          estimated,
          isLast: attempt === ordered.length - 1,
        });
        rateLimitStreak.delete(m.member.id);
        await applyReading(m, adapterFor(m.member)({ headers }, clock.now()), clock.now());
        if (poolOptions.stickyKey !== undefined) {
          await store.setSticky(poolOptions.stickyKey, m.member.id, stickyTtlMs, clock.now());
        }
        return value;
      } catch (error) {
        const now = clock.now();
        const kind = classifyError(error, {
          callerAborted: callerSignal?.aborted ?? false,
          timedOut: error instanceof FirstTokenTimeoutError,
        });
        const isApiError = APICallError.isInstance(error);
        // A rejected (429) or unsent call didn't use quota; anything else reached the provider.
        if (kind === 'rate-limit' || (isApiError && error.statusCode === undefined)) await store.release(reservation, now);
        else await store.commit(reservation, undefined, now);
        if (kind === 'fatal') throw error;
        const reading = isApiError
          ? adapterFor(m.member)({ headers: error.responseHeaders, status: error.statusCode, body: error.responseBody }, now)
          : { truths: [] };
        emit({ type: 'fail', memberId: m.member.id, kind, error });
        // Lower the effective limit first, so the full window drains from the provider's real pace.
        adapt(m, reading, now);
        await applyReading(m, { ...reading, truths: [...reading.truths, ...fullWindows(m, reading, now)] }, now);
        await cooldownAfter(m, kind, reading, now);
        failures.push({
          memberId: m.member.id,
          reason: kind,
          ...(reading.retryAfterMs === undefined ? {} : { retryAfterMs: reading.retryAfterMs }),
        });
        lastError = error;
      }
    }

    const waits = failures.map((f) => f.retryAfterMs).filter((ms): ms is number => ms !== undefined);
    const retryAfterMs = waits.length ? Math.min(...waits) : undefined;
    emit({ type: 'exhausted', retryAfterMs });
    throw new PoolExhaustedError(failures, retryAfterMs, lastError);
  }

  /** An AbortController that follows the caller's signal, plus the first-token timer. */
  function attemptSignal(callerSignal: AbortSignal | undefined, timeoutMs: number | undefined) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onAbort();
    else callerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(new FirstTokenTimeoutError(`no first chunk within ${timeoutMs}ms`)), timeoutMs);
    return {
      signal: controller.signal,
      clearTimer: () => clearTimeout(timer),
      detach: () => callerSignal?.removeEventListener('abort', onAbort),
    };
  }

  function model(poolOptions: PoolModelOptions = {}): LanguageModelV4 {
    return {
      specificationVersion: 'v4',
      provider: 'ai-sdk-quota',
      modelId: members.map((m) => m.member.id).join('|'),
      // Members accept different URLs; an empty map makes the AI SDK download files itself.
      supportedUrls: {},

      doGenerate: (callOptions) =>
        run<LanguageModelV4GenerateResult>(callOptions, poolOptions, async (m, opts, { reservation, estimated }) => {
          const attemptCtl = attemptSignal(callOptions.abortSignal, undefined);
          try {
            const result = await m.member.model.doGenerate({ ...opts, abortSignal: attemptCtl.signal });
            await reconcile(m, reservation, estimated, result.usage);
            const value = { ...result, providerMetadata: { ...result.providerMetadata, ...servedBy(m) } };
            return { value, headers: result.response?.headers };
          } finally {
            attemptCtl.detach();
          }
        }),

      doStream: (callOptions) =>
        run<LanguageModelV4StreamResult>(callOptions, poolOptions, async (m, opts, { reservation, estimated, isLast }) => {
          const attemptCtl = attemptSignal(callOptions.abortSignal, isLast ? undefined : firstTokenTimeoutMs);
          try {
            const pending = m.member.model.doStream({ ...opts, abortSignal: attemptCtl.signal });
            const result = await raceAbort(pending, attemptCtl.signal);
            const stream = await holdUntilFirstChunk(result.stream, {
              signal: attemptCtl.signal,
              onSettle: (usage) => {
                attemptCtl.detach();
                reconcile(m, reservation, estimated, usage).catch((error: unknown) =>
                  emit({ type: 'store-error', memberId: m.member.id, error }),
                );
              },
            });
            attemptCtl.clearTimer();
            const tagged = stream.pipeThrough(
              new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                transform(part, controller) {
                  controller.enqueue(
                    part.type === 'finish' ? { ...part, providerMetadata: { ...part.providerMetadata, ...servedBy(m) } } : part,
                  );
                },
              }),
            );
            // The caller's signal stays attached so leaving mid-reply still stops the member's stream.
            return { value: { ...result, stream: tagged }, headers: result.response?.headers };
          } catch (error) {
            attemptCtl.clearTimer();
            attemptCtl.detach();
            throw attemptCtl.signal.aborted && callOptions.abortSignal?.aborted !== true
              ? attemptCtl.signal.reason
              : error;
          }
        }),
    };
  }

  async function snapshot(): Promise<PoolSnapshot> {
    const now = clock.now();
    const out: PoolSnapshot = { members: [], groups: [] };
    for (const m of members) {
      out.members.push({
        id: m.member.id,
        cooldownUntil: await store.getCooldown(m.member.id, now),
        headroom: await headroom(m, store, now),
        usage: await store.usage(m.key, m.limits, now),
      });
    }
    for (const id of groupIds) {
      const limits = members.flatMap((m) => m.groups).find((g) => g.key === id)!.limits;
      out.groups.push({ id: id.slice(2), usage: await store.usage(id, limits, now) });
    }
    return out;
  }

  async function remaining(budgetKey: string): Promise<Usage> {
    const limits = options.budgets?.perKey;
    return limits ? store.usage(`b:${budgetKey}`, limits, clock.now()) : {};
  }

  return { model, snapshot, remaining };
}

/** Rejects as soon as `signal` aborts, even if the provider ignores the signal. */
function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function withMargin(limits: Limits, margin: number): Limits {
  if (margin === 1) return limits;
  const out: Limits = { ...limits };
  for (const dim of ['rps', 'rpm', 'rpd', 'tpm', 'tpd'] as const) {
    const v = limits[dim];
    if (v !== undefined) out[dim] = Math.max(1, Math.floor(v * margin));
  }
  return out;
}

function resolveMembers(options: QuotaPoolOptions): ResolvedMember[] {
  if (!options.models.length) throw new Error('createQuotaPool: `models` is empty');
  const margin = options.safetyMargin ?? 1;
  if (!(margin > 0 && margin <= 1)) throw new Error('createQuotaPool: `safetyMargin` must be in (0, 1]');
  const seen = new Set<string>();
  return options.models.map((member) => {
    if (seen.has(member.id)) throw new Error(`createQuotaPool: duplicate member id "${member.id}"`);
    seen.add(member.id);
    let limits: Limits = {};
    let groupIds = [...(member.groups ?? [])];
    if (typeof member.limits === 'string') {
      const resolved = resolveLimits(member.limits, member.model.modelId);
      if (!resolved) {
        throw new Error(`createQuotaPool: no registry limits for "${member.limits}" and model "${member.model.modelId}"`);
      }
      limits = resolved.limits;
      groupIds = [...new Set([...resolved.groups, ...groupIds])];
    } else if (member.limits) {
      limits = member.limits;
    }
    const groups = groupIds.map((id) => {
      const groupLimits = options.groups?.[id] ?? resolveGroup(id);
      if (!groupLimits) throw new Error(`createQuotaPool: no limits for group "${id}"`);
      return { key: `g:${id}`, limits: withMargin(groupLimits, margin) };
    });
    return { member, key: `m:${member.id}`, limits: withMargin(limits, margin), groups };
  });
}
