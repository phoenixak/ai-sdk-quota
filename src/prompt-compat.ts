import type { LanguageModelV4Prompt, SharedV4ProviderOptions } from '@ai-sdk/provider';

/**
 * The providerOptions keys a provider reads: each segment of its id, so
 * `google.generative-ai` keeps `google` and `google.vertex.chat` keeps `google` and `vertex`.
 */
export function providerOptionKeys(provider: string): Set<string> {
  return new Set(provider.split('.'));
}

function filterOptions(
  options: SharedV4ProviderOptions | undefined,
  keep: Set<string>,
): { options: SharedV4ProviderOptions | undefined; foreign: boolean } {
  if (!options) return { options, foreign: false };
  const entries = Object.entries(options);
  const kept = entries.filter(([key]) => keep.has(key));
  if (kept.length === entries.length) return { options, foreign: false };
  return { options: kept.length ? Object.fromEntries(kept) : undefined, foreign: true };
}

function withOptions<T extends { providerOptions?: SharedV4ProviderOptions }>(
  value: T,
  options: SharedV4ProviderOptions | undefined,
): T {
  const { providerOptions: _, ...rest } = value;
  return (options ? { ...rest, providerOptions: options } : rest) as T;
}

/**
 * Removes data another provider left in the history: providerOptions keyed to other
 * providers (e.g. Gemini thought signatures on tool calls), and reasoning that was
 * signed by another provider and only makes sense to it. Tool-call ids and results
 * are kept as they are, so a conversation or tool loop can continue on any member.
 */
export function stripForeignProviderData(prompt: LanguageModelV4Prompt, targetProvider: string): LanguageModelV4Prompt {
  const keep = providerOptionKeys(targetProvider);
  return prompt.map((message) => {
    const msg = withOptions(message, filterOptions(message.providerOptions, keep).options);
    if (typeof msg.content === 'string') return msg;
    const content = (msg.content as Array<{ type: string; providerOptions?: SharedV4ProviderOptions }>).flatMap(
      (part) => {
        const { options, foreign } = filterOptions(part.providerOptions, keep);
        const isReasoning = part.type === 'reasoning' || part.type === 'reasoning-file';
        if (isReasoning && foreign && !options) return [];
        return [withOptions(part, options)];
      },
    );
    return { ...msg, content } as typeof msg;
  });
}
