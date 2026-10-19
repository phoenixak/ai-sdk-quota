// Measures one pool call's store work (reserve + commit) against a real database.
// Answers "how much latency does the shared store add per call?".
//   DATABASE_URL=postgres://... node bench/store-latency.mjs        (Postgres / Supabase / Neon)
//   REDIS_URL=redis://...       node bench/store-latency.mjs        (Redis)
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node bench/store-latency.mjs
// Run `npm run build` first. Uses its own key prefix and leaves only short-lived rows.
import { postgresSchemaSql, postgresStore } from '../dist/store/postgres.js';
import { redisStore } from '../dist/store/redis.js';
import { upstashStore } from '../dist/store/upstash.js';

const N = Number(process.env.BENCH_CALLS ?? 200);
const prefix = `bench${Date.now().toString(36)}`;
let store;
let close = async () => {};
let label;

if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  if (process.env.BENCH_CREATE_SCHEMA === '1') await pool.query(postgresSchemaSql(process.env.BENCH_SCHEMA ?? 'public'));
  store = postgresStore(pool, { schema: process.env.BENCH_SCHEMA ?? 'public', prefix });
  close = () => pool.end();
  label = 'postgres';
} else if (process.env.REDIS_URL) {
  const { Redis } = await import('ioredis');
  const client = new Redis(process.env.REDIS_URL);
  store = redisStore(client, { prefix });
  close = () => client.quit();
  label = 'redis';
} else if (process.env.UPSTASH_REDIS_REST_URL) {
  store = upstashStore({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, prefix });
  label = 'upstash';
} else {
  console.error('Set DATABASE_URL, REDIS_URL or UPSTASH_REDIS_REST_URL.');
  process.exit(1);
}

// A realistic charge: one member with four windows, one shared group, one budget key.
const charges = [
  { key: 'm:bench', limits: { rpm: 1e9, rpd: 1e9, tpm: 1e12, tpd: 1e12 }, requests: 1, tokens: 600 },
  { key: 'g:bench', limits: { rpd: 1e9, dailyReset: { timeZone: 'UTC' } }, requests: 1, tokens: 600 },
  { key: 'b:bench', limits: { rpd: 1e9 }, requests: 1, tokens: 600 },
];
const times = [];
for (let i = 0; i < N + 10; i++) {
  const start = performance.now();
  const r = await store.reserve(charges, { now: Date.now(), ttlMs: 60_000 });
  if (!r.ok) throw new Error('unexpected block');
  await store.commit(r.reservation, 420, Date.now());
  if (i >= 10) times.push(performance.now() - start); // skip warm-up
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))].toFixed(2);
console.log(`${label}: reserve+commit over ${N} calls: p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${times.at(-1).toFixed(2)} ms`);
await close();
