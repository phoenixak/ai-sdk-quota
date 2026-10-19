import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'limits/index': 'src/limits/index.ts',
    'store/redis': 'src/store/redis.ts',
    'store/upstash': 'src/store/upstash.ts',
    'store/postgres': 'src/store/postgres.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  external: ['@ai-sdk/provider'],
});
