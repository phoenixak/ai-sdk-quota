// Checks src/limits/registry.json: every entry needs an https source and a valid
// verifiedAt date. Entries older than MAX_AGE_DAYS print a GitHub warning (not a
// failure): limits change often, and a stale entry needs a re-check, not a red build.
import { readFileSync } from 'node:fs';

const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS ?? 60);
const registry = JSON.parse(readFileSync(new URL('../src/limits/registry.json', import.meta.url), 'utf8'));
const now = Date.now();
let errors = 0;
let stale = 0;

for (const [kind, entries] of [
  ['tier', registry.tiers],
  ['group', registry.groups],
]) {
  for (const [id, entry] of Object.entries(entries)) {
    if (!/^https:\/\//.test(entry.source ?? '')) {
      console.log(`::error::registry ${kind} "${id}" has no https source`);
      errors++;
    }
    const verified = Date.parse(entry.verifiedAt ?? '');
    if (Number.isNaN(verified)) {
      console.log(`::error::registry ${kind} "${id}" has no valid verifiedAt date`);
      errors++;
      continue;
    }
    const ageDays = Math.floor((now - verified) / 86_400_000);
    if (ageDays > MAX_AGE_DAYS) {
      console.log(`::warning::registry ${kind} "${id}" was last verified ${ageDays} days ago (${entry.verifiedAt}); re-check ${entry.source}`);
      stale++;
    }
  }
}

console.log(`registry: ${errors} errors, ${stale} stale entries (older than ${MAX_AGE_DAYS} days)`);
process.exit(errors ? 1 : 0);
