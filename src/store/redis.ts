import { QUOTA_SCRIPT, isNoScript, redisBackend, scriptSha } from './redis-backend.js';
import { createScriptedStore } from './scripted.js';
import type { QuotaStore } from './types.js';

/** The two ioredis methods the store uses (`new Redis(url)` from `ioredis` fits). */
export interface RedisLike {
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  /** Namespaces all keys, so several pools can share one database. Default `'aisq'`. */
  prefix?: string;
}

/** A shared store on a Redis server you connect to (ioredis or a compatible client). */
export function redisStore(client: RedisLike, options: RedisStoreOptions = {}): QuotaStore {
  return createScriptedStore(
    redisBackend(async (key, argv) => {
      const sha = await scriptSha();
      try {
        return await client.evalsha(sha, 1, key, ...argv);
      } catch (error) {
        if (!isNoScript(error)) throw error;
        return client.eval(QUOTA_SCRIPT, 1, key, ...argv);
      }
    }, options.prefix ?? 'aisq'),
  );
}
