import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';

/** Parts that carry nothing the caller can see yet; a switch after these duplicates nothing. */
const HELD = new Set<LanguageModelV4StreamPart['type']>([
  'stream-start',
  'response-metadata',
  'raw',
  'text-start',
  'reasoning-start',
]);

export interface HoldOptions {
  /** Aborting it (first-token timeout, or the caller leaving) stops the wait. */
  signal: AbortSignal;
  /** Called exactly once when the stream ends: with usage from `finish`, or without it. */
  onSettle: (usage: LanguageModelV4Usage | undefined) => void;
}

/**
 * Reads until the first part the caller would see. Throws if the stream fails before
 * that (an `error` part, a read error, or `signal` aborting), so the pool can move on
 * to the next member. Otherwise returns a stream that replays what was held back and
 * then forwards everything, including later errors, unchanged.
 */
export async function holdUntilFirstChunk(
  source: ReadableStream<LanguageModelV4StreamPart>,
  { signal, onSettle }: HoldOptions,
): Promise<ReadableStream<LanguageModelV4StreamPart>> {
  const reader = source.getReader();
  const held: LanguageModelV4StreamPart[] = [];
  let finished = false;

  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) {
        finished = true;
        break;
      }
      const part = next.value;
      if (part.type === 'error') throw part.error;
      held.push(part);
      if (!HELD.has(part.type)) break;
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  }

  let settled = false;
  const settle = (usage: LanguageModelV4Usage | undefined) => {
    if (settled) return;
    settled = true;
    onSettle(usage);
  };
  let usage: LanguageModelV4Usage | undefined;
  const track = (part: LanguageModelV4StreamPart) => {
    if (part.type === 'finish') usage = part.usage;
  };
  held.forEach(track);

  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of held) controller.enqueue(part);
      if (finished) {
        settle(usage);
        controller.close();
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle(usage);
          controller.close();
          return;
        }
        track(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        settle(usage);
        controller.error(error);
      }
    },
    async cancel(reason) {
      // The consumer went away (e.g. the browser tab closed): no finish part will come.
      settle(usage);
      await reader.cancel(reason);
    },
  });
}
