# Releasing

Checklist for `0.1.0`. Later releases repeat only the "Every release" part.

## One-time setup (maintainer)

- [ ] **npm account** at npmjs.com with **2FA turned on** (Account → Two-Factor Authentication → "Authorization and writes").
- [ ] Check the name is still free: `npm view ai-sdk-quota` should print a 404.
- [ ] **Sanitize review, pass 1:** read every file in the repo top to bottom.
- [ ] **Sanitize review, pass 2:** `sh scripts/check-private-terms.sh <your local terms file>` finds nothing, and the `leaks` workflow (gitleaks over the full history) is green.
- [ ] **Make the repo public:** GitHub → Settings → General → Danger Zone → Change visibility. npm only shows provenance for public repos.
- [ ] Turn on **secret scanning** and **push protection**: Settings → Code security.
- [ ] **First-publish auth**, pick one:
  - If npmjs.com lets you add a trusted publisher before the package exists: add one for repo `phoenixak/ai-sdk-quota`, workflow `release.yml`. No token needed.
  - Otherwise: create a **granular access token** (npmjs.com → Access Tokens → Generate → Granular; packages: read and write; expiry: 7 days) and save it as the repo secret `NPM_TOKEN`. After the first publish, add the trusted publisher in the package settings, delete the `NPM_TOKEN` secret and revoke the token.
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
