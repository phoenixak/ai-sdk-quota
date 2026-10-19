import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { FILE_PART_TOKENS, OutputEstimator, estimateInputTokens } from '../src/estimate.js';

describe('estimateInputTokens', () => {
  it('counts text across every part type', () => {
    const options: LanguageModelV4CallOptions = {
      prompt: [
        { role: 'system', content: 'x'.repeat(35) },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'y'.repeat(7) },
            { type: 'file', data: { type: 'data', data: 'aGk=' }, mediaType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'r'.repeat(7) },
            { type: 'tool-call', toolCallId: '1', toolName: 'abc', input: { q: 1 } },
            { type: 'tool-call', toolCallId: '2', toolName: 'abc', input: '{"q":1}' },
            { type: 'reasoning-file', data: { type: 'data', data: 'aGk=' }, mediaType: 'image/png' },
            { type: 'custom', kind: 'x.y' },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: '1', toolName: 'abc', output: { type: 'text', value: 'ok' } }],
        },
      ],
    };
    // chars: 35 + 7 + 7 + (3+7) + (3+7) + (3+28) = 100 → ceil(100/3.5) = 29
    expect(estimateInputTokens(options)).toBe(29 + 2 * FILE_PART_TOKENS);
  });

  it('handles tool calls without input', () => {
    const options: LanguageModelV4CallOptions = {
      prompt: [{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'abcdefg', input: undefined }] }],
    };
    expect(estimateInputTokens(options)).toBe(2);
  });

  it('adds tool definitions and the JSON schema', () => {
    const base: LanguageModelV4CallOptions = { prompt: [{ role: 'system', content: '' }] };
    expect(estimateInputTokens(base)).toBe(0);
    const tools: LanguageModelV4CallOptions['tools'] = [
      { type: 'function', name: 'f', inputSchema: { type: 'object' } },
    ];
    expect(estimateInputTokens({ ...base, tools })).toBe(Math.ceil(JSON.stringify(tools).length / 3.5));
    expect(estimateInputTokens({ ...base, tools: [] })).toBe(0);
    expect(estimateInputTokens({ ...base, responseFormat: { type: 'json' } })).toBe(1);
    expect(estimateInputTokens({ ...base, responseFormat: { type: 'json', schema: { type: 'string' } } })).toBe(5);
    expect(estimateInputTokens({ ...base, responseFormat: { type: 'text' } })).toBe(0);
  });
});

describe('OutputEstimator', () => {
  it('starts from the default and follows real replies', () => {
    const e = new OutputEstimator(512, 0.5);
    expect(e.expected('a')).toBe(512);
    expect(e.expected('a', 100)).toBe(100);
    e.observe('a', 200);
    expect(e.expected('a')).toBe(200);
    e.observe('a', 400);
    expect(e.expected('a')).toBe(300);
    expect(e.expected('b')).toBe(512);
  });

  it('keeps a small TPM limit usable when maxOutputTokens is large', () => {
    // Groq free: 8K TPM. Reserving maxOutputTokens (4,096) would allow ~2 calls a minute.
    const e = new OutputEstimator();
    for (let i = 0; i < 20; i++) e.observe('groq', 300);
    const perCall = 200 + e.expected('groq', 4_096);
    expect(Math.floor(8_000 / perCall)).toBeGreaterThanOrEqual(15);
  });
});
