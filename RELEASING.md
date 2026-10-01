# Releasing staple-cli

Releases are tag-triggered and CI-only. Nothing is ever published from a
laptop; `.github/workflows/release.yml` publishes `dist-package/` to npm with
provenance via trusted publishing (OIDC). There is no npm token in this repo's
secrets, and none should ever be added.

## Schema contract — read before tagging

- **This repository is canonical.** It carries workspace migrations 001-006
  (schema 6), which is what the live workspace is stamped with. The Workshop
  prototype checkout it was extracted from stopped at schema 3 and is retired:
  it refuses the live database (`error(conflict)`, exit 4) and must stay that
  way — never run it against the live workspace, and never re-sync from it.
- **The artifact declares what it understands.** `npm run build:package`
  stamps `staple.workspaceSchema` and `staple.hubSchema` into
  `dist-package/package.json` from the migration lists compiled into the
  bundle; `test/package-tarball.test.ts` pins that the numbers match. A
  release whose declared schema is lower than the live workspace's stamp
  installs fine but refuses to open it — that is a release that must not be
  tagged for real use.
- **Upgrades snapshot first.** An installed runtime that finds a workspace
  behind its schema takes a `VACUUM INTO` snapshot beside the database before
  migrating it, and retains the prior runtime under `<home>/runtime/versions/`
  for `staple install --rollback --yes`. See `design/migration.md`.
- **The schema matrix is a release gate.** `test/install-schema-matrix.test.ts`
  drives the packed runtime through the real launcher against the schema-3,
  -5, -6, future-schema and WAL-backed fixtures, an interrupted install, and
  the commands `design/migration.md` prints. It runs in every `npm test`, against
  a payload the suite builds from the checkout's source with the same
  `buildPackage()` that produces `dist-package/`, so it cannot skip and
  cannot pass against a stale build. On its own:

  ```bash
  npx vitest run test/install-schema-matrix.test.ts
  ```

## One-time npm setup (VP only, before the first release)

npm cannot attach a Trusted Publisher to a package that does not exist yet:
the setting lives on the package's own settings page, and there is no
"pending publisher" for a new name (open request:
<https://github.com/npm/cli/issues/8544>). So the first version of
`staple-cli` cannot come from this workflow. The bootstrap below creates the
package with a placeholder, then hands every real release to CI. The
placeholder is the only thing ever published from a laptop.

`staple-cli` was unclaimed on 2026-10-01 (`npm view staple-cli` → 404), and
npm's name-similarity rule does not block it (no `staplecli` exists).

1. Log in to <https://www.npmjs.com> as the account that will own
   `staple-cli`, with two-factor authentication on.
2. Publish a placeholder `0.0.0` from your own machine (no bin, nothing
   runnable):

   ```bash
   d=$(mktemp -d) && cd "$d"
   printf '{"name":"staple-cli","version":"0.0.0","description":"Placeholder. Install the latest version.","license":"MIT","repository":{"type":"git","url":"git+https://github.com/vpetkovic/staple-tracker.git"}}\n' > package.json
   printf '# staple-cli\n\nPlaceholder that claims the name. See https://vpetkovic.github.io/staple-tracker/\n' > README.md
   npm login && npm publish --access public    # asks for your 2FA code
   ```

   Until the first CI release, `npx staple-cli` resolves to this placeholder
   and fails with "could not determine executable". Tag `v0.1.0` right after
   step 4 to keep that window to minutes.
3. On <https://www.npmjs.com/package/staple-cli/access> → **Trusted
   Publisher** → **GitHub Actions**, enter exactly:
   - **Organization or user:** `vpetkovic`
   - **Repository:** `staple-tracker`
   - **Workflow filename:** `release.yml`
   - **Environment:** leave blank (the workflow does not use one).
4. On the same page, under **Publishing access**, choose **Require two-factor
   authentication and disallow tokens**. OIDC publishing keeps working;
   token publishing stops.
5. After `v0.1.0` is live: `npm deprecate staple-cli@0.0.0 "placeholder; use the latest version"`.

Never create an npm automation token or add one to the repository's secrets.
The workflow authenticates through OIDC (`id-token: write`). Trusted
publishing needs npm >= 11.5.1 on Node >= 22.14, and the workflow installs
npm 11 itself. Provenance is generated automatically and requires the
manifest's `repository.url` to match this repository, which
`npm run build:package` copies from the root `package.json`. References:
<https://docs.npmjs.com/trusted-publishers>,
<https://docs.npmjs.com/generating-provenance-statements>.

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
     `npm run drill:npx` (`npm test` includes the schema matrix above);
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
  somehow < 11.5.1. Fix the publisher config; never work around it by adding a
  token secret.
- **Publish fails with ENEEDAUTH:** something wrote an `_authToken` line into
  `.npmrc` (for example `registry-url` on `actions/setup-node`), so npm never
  tried OIDC. Remove it.
- **Publish fails with E422 about provenance:** the published manifest's
  `repository.url` does not match `github.com/vpetkovic/staple-tracker`.
- **Post-publish version check fails after retries:** the registry did not
  serve the new version; investigate on npmjs.com before re-tagging.
