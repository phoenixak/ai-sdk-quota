import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';

/** Conservative for English and Arabic text across common tokenizers. */
export const CHARS_PER_TOKEN = 3.5;
/** Flat guess for an image or file part; reconcile corrects it after the call. */
export const FILE_PART_TOKENS = 1_000;

export type EstimateTokens = (options: LanguageModelV4CallOptions) => number;

/** Estimates prompt tokens from text length: messages, tool definitions and the response schema. */
export const estimateInputTokens: EstimateTokens = (options) => {
  let chars = 0;
  let files = 0;
  for (const message of options.prompt) {
    if (typeof message.content === 'string') {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          chars += part.text.length;
          break;
        case 'tool-call':
          chars += part.toolName.length + jsonLength(part.input);
          break;
        case 'tool-result':
          chars += part.toolName.length + jsonLength(part.output);
          break;
        case 'file':
        case 'reasoning-file':
          files++;
          break;
        default:
          break;
      }
    }
  }
  if (options.tools?.length) chars += jsonLength(options.tools);
  if (options.responseFormat?.type === 'json') chars += jsonLength(options.responseFormat.schema ?? {});
  return Math.ceil(chars / CHARS_PER_TOKEN) + files * FILE_PART_TOKENS;
};

function jsonLength(value: unknown): number {
  return typeof value === 'string' ? value.length : (JSON.stringify(value) ?? '').length;
}

/**
 * Expected output size per member. Reserving the full `maxOutputTokens` would starve
 * token-per-minute limits (8K TPM / 4,096 max output = two calls a minute), so start
 * from a typical reply size and follow a running average of real replies.
 */
export class OutputEstimator {
  readonly #averages = new Map<string, number>();

  constructor(
    private readonly initial = 512,
    private readonly alpha = 0.2,
  ) {}

  expected(memberId: string, maxOutputTokens?: number): number {
    const avg = Math.ceil(this.#averages.get(memberId) ?? this.initial);
    return maxOutputTokens === undefined ? avg : Math.min(avg, maxOutputTokens);
  }

  observe(memberId: string, outputTokens: number): void {
    const prev = this.#averages.get(memberId);
    this.#averages.set(memberId, prev === undefined ? outputTokens : prev + this.alpha * (outputTokens - prev));
  }
}
