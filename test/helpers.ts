import {
  APICallError,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

export function usage(input: number | undefined, output: number | undefined): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

export function generated(
  text: string,
  u = usage(10, 5),
  headers?: Record<string, string>,
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: u,
    warnings: [],
    ...(headers ? { response: { headers } } : {}),
  };
}

export function textParts(text: string, u = usage(10, 5)): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: u },
  ];
}

export function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

export function streamed(parts: LanguageModelV4StreamPart[], headers?: Record<string, string>): LanguageModelV4StreamResult {
  return { stream: streamOf(parts), ...(headers ? { response: { headers } } : {}) };
}

/** A stream that never produces anything until cancelled. */
export function silentStream(): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({ pull: () => new Promise(() => {}) });
}

export function apiError(statusCode: number | undefined, extra: { headers?: Record<string, string>; body?: string } = {}) {
  return new APICallError({
    message: `HTTP ${statusCode ?? 'network'}`,
    url: 'https://api.example.com/v1/chat',
    requestBodyValues: {},
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(extra.headers ? { responseHeaders: extra.headers } : {}),
    ...(extra.body ? { responseBody: extra.body } : {}),
    isRetryable: statusCode === undefined || statusCode === 429 || statusCode >= 500,
  });
}

export function mock(provider: string, modelId: string, impl: ConstructorParameters<typeof MockLanguageModelV4>[0] = {}) {
  return new MockLanguageModelV4({ provider, modelId, ...impl });
}

export const userPrompt = (text: string) => [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }];
