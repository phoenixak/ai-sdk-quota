import { PGlite } from '@electric-sql/pglite';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresSchemaSql, postgresStore } from '../src/store/postgres.js';
import { QUOTA_SCRIPT } from '../src/store/redis-backend.js';
import { redisStore } from '../src/store/redis.js';
import { upstashStore } from '../src/store/upstash.js';
import { describeStoreContract } from './store-contract.js';

const { DATABASE_URL, REDIS_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, REQUIRE_SERVICE_STORES } = process.env;

if (REQUIRE_SERVICE_STORES === '1') {
  it('has every service store configured', () => {
    expect({ DATABASE_URL, REDIS_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN }).toEqual({
      DATABASE_URL: expect.any(String),
      REDIS_URL: expect.any(String),
      UPSTASH_REDIS_REST_URL: expect.any(String),
      UPSTASH_REDIS_REST_TOKEN: expect.any(String),
    });
  });
}

const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

// Postgres in WebAssembly: runs everywhere, no service needed.
let pglite: Promise<PGlite> | undefined;
function getPglite() {
  pglite ??= (async () => {
    const db = new PGlite();
    await db.exec(postgresSchemaSql('quota'));
    closers.push(() => db.close());
    return db;
  })();
  return pglite;
}
describeStoreContract('postgresStore (PGlite)', async (prefix) => postgresStore(await getPglite(), { schema: 'quota', prefix }));

if (DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  closers.push(() => pool.end());
  let ready: Promise<unknown> | undefined;
  describeStoreContract(
    'postgresStore (pg)',
    async (prefix) => {
      ready ??= pool.query(postgresSchemaSql('quota_test'));
      await ready;
      return postgresStore(pool, { schema: 'quota_test', prefix });
    },
    { shared: true },
  );
}

if (REDIS_URL) {
  const clients: Redis[] = [];
  closers.push(async () => Promise.all(clients.map((c) => c.quit())));
  describeStoreContract(
    'redisStore (ioredis)',
    (prefix) => {
      const client = new Redis(REDIS_URL);
      clients.push(client);
      return redisStore(client, { prefix });
    },
    { shared: true },
  );

  it('redisStore loads the script when the server has not seen it', async () => {
    const client = new Redis(REDIS_URL);
    clients.push(client);
    await client.script('FLUSH');
    const store = redisStore(client, { prefix: 'flushed' });
    expect(await store.getCooldown('x', 0)).toBe(0);
  });

  it('the script rejects unknown operations', async () => {
    const client = new Redis(REDIS_URL);
    clients.push(client);
    await expect(client.eval(QUOTA_SCRIPT, 1, '{x}:lock', 'nope', 'x', '0')).rejects.toThrow('unknown op nope');
  });
}

if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  describeStoreContract(
    'upstashStore (REST)',
    (prefix) => upstashStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN, prefix }),
    { shared: true },
  );
}

describe('store clients without a server', () => {
  const okJson = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

  it('upstashStore falls back to EVAL on NOSCRIPT and sends the token only as a header', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response(JSON.stringify({ error: 'NOSCRIPT No matching script.' }), { status: 400 });
      return okJson(null);
    }) as unknown as typeof fetch;
    const store = upstashStore({ url: 'https://db.example.com/', token: 'secret-token', fetch: fetchStub });
    expect(await store.getCooldown('a', 0)).toBe(0);
    expect(calls.map((c) => JSON.parse(String(c.init.body))[0])).toEqual(['EVALSHA', 'EVAL']);
    expect(calls[0]!.url).toBe('https://db.example.com');
    expect(calls[0]!.init.headers).toEqual({ Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' });
    expect(String(calls[0]!.init.body)).not.toContain('secret-token');
  });

  it('upstashStore surfaces errors, including non-JSON ones', async () => {
    const fail = (async () => new Response(JSON.stringify({ error: 'WRONGPASS' }), { status: 401 })) as unknown as typeof fetch;
    await expect(upstashStore({ url: 'https://db.example.com', token: 't', fetch: fail }).getCooldown('a', 0)).rejects.toThrow(
      'Upstash request failed (401): WRONGPASS',
    );
    const html = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(upstashStore({ url: 'https://db.example.com', token: 't', fetch: html }).getCooldown('a', 0)).rejects.toThrow(
      '(502): no error message',
    );
    expect(() => upstashStore({ url: '', token: 't' })).toThrow('required');
    expect(() => upstashStore({ url: 'https://db.example.com', token: '', prefix: 'x' })).toThrow('required');
  });

  it('upstashStore uses the global fetch by default', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => okJson('123')) as unknown as typeof fetch;
    try {
      expect(await upstashStore({ url: 'https://db.example.com', token: 't' }).getCooldown('a', 0)).toBe(123);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('redisStore rethrows errors other than NOSCRIPT, and validates the prefix', async () => {
    const client = {
      evalsha: async () => {
        throw new Error('READONLY replica');
      },
      eval: async () => null,
    };
    await expect(redisStore(client).getCooldown('a', 0)).rejects.toThrow('READONLY');
    expect(() => redisStore(client, { prefix: 'a{b}' })).toThrow('must not contain');
    const noscript = { evalsha: async () => Promise.reject('NOSCRIPT'), eval: async () => '42' };
    expect(await redisStore(noscript).getCooldown('a', 0)).toBe(42);
  });

  it('postgresStore validates the schema and accepts JSON returned as text', async () => {
    expect(() => postgresStore({ query: async () => ({ rows: [] }) }, { schema: 'bad;drop' })).toThrow('invalid schema');
    expect(() => postgresSchemaSql('Bad')).toThrow('invalid schema');
    const store = postgresStore({ query: async () => ({ rows: [{ r: JSON.stringify({ until: 99 }) }] }) });
    expect(await store.getCooldown('a', 0)).toBe(99);
  });
});
