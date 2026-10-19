// Fails if the core entry, minified and gzipped the way a bundler would ship it, exceeds the budget.
// Subpath entries (stores, limits, cli) are optional and measured separately for information.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const BUDGET = 10 * 1024;
const entries = {
  core: 'dist/index.js',
  'stores/upstash': 'dist/store/upstash.js',
  'stores/redis': 'dist/store/redis.js',
  'stores/postgres': 'dist/store/postgres.js',
};
let failed = false;
for (const [name, file] of Object.entries(entries)) {
  const out = await build({
    entryPoints: [file],
    bundle: true,
    minify: true,
    format: 'esm',
    write: false,
    platform: 'neutral',
    external: ['@ai-sdk/provider'],
  });
  const gz = gzipSync(out.outputFiles[0].contents).length;
  const over = name === 'core' && gz > BUDGET;
  failed ||= over;
  console.log(`${name}: ${(gz / 1024).toFixed(2)} KB min+gzip${name === 'core' ? ` (budget ${BUDGET / 1024} KB)${over ? ' OVER' : ''}` : ''}`);
}
process.exit(failed ? 1 : 0);
