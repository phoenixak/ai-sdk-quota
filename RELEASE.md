# Releasing

Checklist for `0.1.0`. Later releases repeat only the "Every release" part.

## One-time setup (maintainer)

- [ ] **npm account** at npmjs.com with **2FA turned on** (Account → Two-Factor Authentication → "Authorization and writes").
- [ ] Check the name is still free: `npm view ai-sdk-quota` should print a 404.
- [ ] **Sanitize review, pass 1:** read every file in the repo top to bottom.
- [ ] **Sanitize review, pass 2:** `sh scripts/check-private-terms.sh <your local terms file>` finds nothing, and the `leaks` workflow (gitleaks over the full history) is green.
- [ ] **Make the repo public:** GitHub → Settings → General → Danger Zone → Change visibility. npm only shows provenance for public repos.
- [ ] Turn on **secret scanning** and **push protection**: Settings → Code security.
- [x] **Publishing auth:** trusted publishing, no tokens. `npm trust github ai-sdk-quota --file release.yml --repo phoenixak/ai-sdk-quota --allow-publish --auth-type=web` (run by the maintainer; 2FA approves in the browser). For a package that doesn't exist yet, it reserves the name with a `0.0.0-stage` placeholder and attaches the trust.
- [x] **0.1.0 was published from the maintainer's PC** (`npm publish --provenance=false --auth-type=web`), so it has no provenance badge. A new package's first version is held in npm's automated review ("Validating") for a while; during that time the version counts as taken, so the Actions publish of the same version fails with `409 ... previously staged version`. Harmless. Every later version publishes from Actions with provenance.
- [ ] After the first publish, in the package settings on npmjs.com: Publishing access → "Require two-factor authentication and disallow tokens". Trusted publishing keeps working.

## Every release

- [ ] `main` is green: `ci`, `leaks` and the latest `nightly` (10,000 property runs).
- [ ] Registry entries are fresh: `npm run check:registry` shows no stale entries, or the stale ones were re-checked against their source.
- [ ] Locally with the Docker services: `docker compose -f docker-compose.test.yml up -d`, then `npm run test:services`, then `npm run build && npm run lint:pkg && npm run check:size`.
- [ ] `node examples/mock-chat.ts` prints one clean reply.
- [ ] Move the `CHANGELOG.md` entry from "unreleased" to the version and date; set `"version"` in `package.json` to match.
- [ ] Commit, then tag and push: `git tag v0.1.0 && git push origin main v0.1.0`. The `release` workflow runs every gate again and publishes with provenance.
- [ ] Check npmjs.com/package/ai-sdk-quota shows the version and the provenance badge, then try `npm i ai-sdk-quota` in an empty folder.
- [ ] Create a GitHub release from the tag with the changelog entry.
