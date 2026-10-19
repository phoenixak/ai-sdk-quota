import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { providerOptionKeys, stripForeignProviderData } from '../src/prompt-compat.js';

// A Gemini-shaped turn: thought signatures on reasoning and tool calls.
const history: LanguageModelV4Prompt = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: [{ type: 'text', text: 'Weather in Cairo?' }], providerOptions: { google: { x: 1 } } },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'Need the tool.', providerOptions: { google: { thoughtSignature: 'sig-1' } } },
      { type: 'reasoning', text: 'Plain reasoning.' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'weather',
        input: { city: 'Cairo' },
        providerOptions: { google: { thoughtSignature: 'sig-2' }, groq: { keep: true } },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'weather',
        output: { type: 'json', value: { c: 31 } },
        providerOptions: { google: { y: 2 } },
      },
    ],
  },
];

describe('stripForeignProviderData', () => {
  it('removes another provider’s data but keeps ids and results', () => {
    const out = stripForeignProviderData(history, 'groq.chat');
    expect(out).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Cairo?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Plain reasoning.' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'weather', input: { city: 'Cairo' }, providerOptions: { groq: { keep: true } } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'weather', output: { type: 'json', value: { c: 31 } } }],
      },
    ]);
  });

  it('keeps the signatures for the provider that wrote them', () => {
    const out = stripForeignProviderData(history, 'google.generative-ai');
    expect(out.slice(0, 2)).toEqual(history.slice(0, 2));
    expect(out[2]!.content).toEqual([
      { type: 'reasoning', text: 'Need the tool.', providerOptions: { google: { thoughtSignature: 'sig-1' } } },
      { type: 'reasoning', text: 'Plain reasoning.' },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'weather',
        input: { city: 'Cairo' },
        providerOptions: { google: { thoughtSignature: 'sig-2' } },
      },
    ]);
    expect(out[3]).toEqual(history[3]);
  });

  it('keeps reasoning that still has options for the target', () => {
    const out = stripForeignProviderData(
      [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'r', providerOptions: { google: { a: 1 }, vertex: { b: 2 } } },
            { type: 'reasoning-file', data: { type: 'data', data: 'aGk=' }, mediaType: 'image/png', providerOptions: { anthropic: { s: 1 } } },
          ],
        },
      ],
      'google.vertex.chat',
    );
    expect(out[0]!.content).toEqual([{ type: 'reasoning', text: 'r', providerOptions: { google: { a: 1 }, vertex: { b: 2 } } }]);
  });

  it('derives option keys from the provider id', () => {
    expect([...providerOptionKeys('google.vertex.chat')]).toEqual(['google', 'vertex', 'chat']);
  });
});
