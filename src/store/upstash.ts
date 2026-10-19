import { QUOTA_SCRIPT, isNoScript, redisBackend, scriptSha } from './redis-backend.js';
import { createScriptedStore } from './scripted.js';
import type { QuotaStore } from './types.js';

export interface UpstashStoreOptions {
  /** The database's REST URL (`UPSTASH_REDIS_REST_URL`). */
  url: string;
  /** The database's REST token (`UPSTASH_REDIS_REST_TOKEN`). Sent only in the Authorization header. */
  token: string;
  /** Namespaces all keys, so several pools can share one database. Default `'aisq'`. */
  prefix?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A shared store on Upstash Redis over its REST API, with no client dependency.
 * Works on Vercel, Cloudflare Workers and other edge runtimes. Each store call is one
 * EVALSHA request (two the first time, when the script is loaded).
 */
export function upstashStore(options: UpstashStoreOptions): QuotaStore {
  if (!options.url || !options.token) throw new Error('upstashStore: `url` and `token` are required');
  const doFetch = options.fetch ?? fetch;
  const url = options.url.replace(/\/+$/, '');

  async function send(command: string[]): Promise<unknown> {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const body = (await response.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!response.ok || body.error !== undefined) {
      throw new Error(`Upstash request failed (${response.status}): ${body.error ?? 'no error message'}`);
    }
    return body.result;
  }

  return createScriptedStore(
    redisBackend(async (key, argv) => {
      const sha = await scriptSha();
      try {
        return await send(['EVALSHA', sha, '1', key, ...argv]);
      } catch (error) {
        if (!isNoScript(error)) throw error;
        return send(['EVAL', QUOTA_SCRIPT, '1', key, ...argv]);
      }
    }, options.prefix ?? 'aisq'),
  );
}
