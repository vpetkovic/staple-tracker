# Releasing staple-cli

Releases are tag-triggered and CI-only. Nothing is ever published from a
laptop; `.github/workflows/release.yml` publishes `dist-package/` to npm with
provenance via trusted publishing (OIDC). There is no npm token in this repo's
secrets, and none should ever be added.

## RELEASE BLOCKERS — read before the first real tag

- **Schema drift vs. the Workshop prototype.** The tree extracted into this
  repo is the prototype's committed snapshot at `0aa2ee0` — **workspace schema
  v2, pre-T-epic**. The parent prototype has in-flight work (schema v3
  migrations from the T epic, timing fields, and the site retake) that is NOT
  in this snapshot.
- **Consequence:** an installed `staple-cli` 0.1.0 built from this snapshot
  will refuse to open VP's own live hub/workspace databases, which are already
  migrated to schema v3. Fresh installs and fresh workspaces are unaffected.
- **Required action:** a deliberate re-sync from the prototype into this repo
  must happen after VP commits the in-flight prototype work and **before the
  first real release tag**. Until that re-sync lands, do not tag a release
  intended for real use.

## One-time npm setup (VP only, before the first release)

The `staple-cli` name is unclaimed on npm (verified 2026-09-01). Claim it by
configuring a Trusted Publisher — this both creates the package on first
publish and removes any need for a token:

1. Log in to <https://www.npmjs.com> as the account that will own `staple-cli`.
2. Go to the Trusted Publisher configuration for the `staple-cli` package
   (for a brand-new package: your account → Packages → "Add Package" /
   trusted publishing flow; npm lets you pre-register a trusted publisher for
   a name you have not published yet).
3. Choose **GitHub Actions** as the publisher and enter exactly:
   - **Organization or user:** `vpetkovic`
   - **Repository:** `staple-tracker`
   - **Workflow filename:** `release.yml`
   - **Environment:** leave blank (the workflow does not use one).
4. Do NOT create or store an npm automation token. The workflow authenticates
   via OIDC (`id-token: write`) and requires npm >= 11.5, which the workflow
   installs itself.

That is the entirety of the manual npm-side setup. It is done once; every
subsequent release is just the tag flow below.

## Cutting a release

1. **Bump the version in the source `package.json`** (repo root). This is the
   single source of truth — `npm run build:package` generates
   `dist-package/package.json` from it, so do not edit the artifact manifest
   by hand.
2. Commit the bump on `master` and make sure CI is green (CI runs the same
   gates plus the clean-machine drill).
3. Tag and push the tag (version must match the bump exactly):

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. The `Release` workflow runs automatically:
   - gates: `npm test`, `npm run typecheck`, `npm run smoke:mcp`,
     `npm run drill:npx`;
   - guard: the tag must equal the version in BOTH `package.json` and the
     freshly built `dist-package/package.json`, or the job fails before
     publishing;
   - `npm publish ./dist-package --provenance --access public`;
   - post-publish check: `npm view staple-cli version` must equal the tag.
5. Verify from a clean shell:

   ```bash
   npx -y staple-cli@X.Y.Z --version
   ```

## What can go wrong

- **Tag/version mismatch:** the guard step fails and nothing is published.
  Delete the bad tag, fix `package.json`, re-tag.
- **Publish fails with an auth error:** the trusted publisher on npmjs.com
  does not match `vpetkovic/staple-tracker` + `release.yml`, or npm was
  somehow < 11.5. Fix the publisher config; never work around it by adding a
  token secret.
- **Post-publish version check fails after retries:** the registry did not
  serve the new version; investigate on npmjs.com before re-tagging.
