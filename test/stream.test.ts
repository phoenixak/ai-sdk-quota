import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { convertReadableStreamToArray } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { holdUntilFirstChunk } from '../src/stream.js';
import { silentStream, streamOf, textParts, usage } from './helpers.js';

function setup() {
  const settled: (LanguageModelV4Usage | undefined)[] = [];
  return { settled, onSettle: (u: LanguageModelV4Usage | undefined) => settled.push(u), signal: new AbortController().signal };
}

describe('holdUntilFirstChunk', () => {
  it('replays held parts and settles with the finish usage', async () => {
    const s = setup();
    const out = await holdUntilFirstChunk(streamOf(textParts('hi', usage(3, 2))), s);
    expect(s.settled).toEqual([]);
    expect((await convertReadableStreamToArray(out)).map((p) => p.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(s.settled).toEqual([usage(3, 2)]);
  });

  it('throws an error part that arrives before the first visible chunk', async () => {
    const s = setup();
    const boom = new Error('boom');
    await expect(
      holdUntilFirstChunk(streamOf([{ type: 'stream-start', warnings: [] }, { type: 'error', error: boom }]), s),
    ).rejects.toBe(boom);
    expect(s.settled).toEqual([]);
  });

  it('throws a read error before the first visible chunk', async () => {
    const s = setup();
    const source = new ReadableStream<LanguageModelV4StreamPart>({ pull: (c) => c.error(new Error('reset')) });
    await expect(holdUntilFirstChunk(source, s)).rejects.toThrow('reset');
  });

  it('stops waiting when the signal aborts, before or during the wait', async () => {
    const pre = new AbortController();
    pre.abort(new Error('already'));
    await expect(holdUntilFirstChunk(silentStream(), { ...setup(), signal: pre.signal })).rejects.toThrow('already');

    const ctl = new AbortController();
    const pending = holdUntilFirstChunk(silentStream(), { ...setup(), signal: ctl.signal });
    ctl.abort(new Error('timeout'));
    await expect(pending).rejects.toThrow('timeout');
  });

  it('commits on a finish with no content, and on an empty stream', async () => {
    const s = setup();
    const finishOnly: LanguageModelV4StreamPart[] = [
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(1, 0) },
    ];
    const out = await holdUntilFirstChunk(streamOf(finishOnly), s);
    await convertReadableStreamToArray(out);
    expect(s.settled).toEqual([usage(1, 0)]);

    const empty = setup();
    const out2 = await holdUntilFirstChunk(streamOf([{ type: 'stream-start', warnings: [] }]), empty);
    expect(empty.settled).toEqual([undefined]);
    expect(await convertReadableStreamToArray(out2)).toEqual([{ type: 'stream-start', warnings: [] }]);
  });

  it('passes errors after commit through and settles once', async () => {
    const s = setup();
    let n = 0;
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      pull(c) {
        if (n++ === 0) c.enqueue({ type: 'text-delta', id: 't', delta: 'partial' });
        else c.error(new Error('mid-stream'));
      },
    });
    const out = await holdUntilFirstChunk(source, s);
    await expect(convertReadableStreamToArray(out)).rejects.toThrow('mid-stream');
    expect(s.settled).toEqual([undefined]);
  });

  it('settles once when the consumer cancels', async () => {
    const s = setup();
    const cancel = vi.fn();
    let sent = false;
    const source = new ReadableStream<LanguageModelV4StreamPart>({
      pull(c) {
        if (!sent) c.enqueue({ type: 'text-delta', id: 't', delta: 'a' });
        sent = true;
      },
      cancel,
    });
    const out = await holdUntilFirstChunk(source, s);
    const reader = out.getReader();
    await reader.read();
    await reader.cancel('tab closed');
    await reader.cancel('again').catch(() => {});
    expect(s.settled).toEqual([undefined]);
    expect(cancel).toHaveBeenCalledWith('tab closed');
  });
});
