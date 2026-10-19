// Runs the full suite against the services in docker-compose.test.yml (works on any OS).
import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  REQUIRE_SERVICE_STORES: '1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:test@localhost:5440/quota',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6390',
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? 'local_test_token',
};
const result = spawnSync('npx', ['vitest', 'run', '--coverage', ...process.argv.slice(2)], { env, stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
