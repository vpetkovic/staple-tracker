# Contributing to staple

This guide is for people hacking on staple itself. If you just want to *use*
staple, you never need any of this — the entire install is
`npx staple-cli` (see the [README](README.md)).

The user guides and reference live in [docs/](docs/), which the site renders.
The design documents behind the code — the store's semantics, the cloud sync
protocol, timing and telemetry, architecture, migration and packaging — live in
[design/](design/README.md), which the site does not render.

## Prerequisites

- Node.js >= 22.5 (`node:sqlite` is built in from there; it prints an
  experimental warning on 22.x and is stable in 24)
- git

## Setup

```bash
git clone https://github.com/vpetkovic/staple-tracker
cd staple-tracker
npm install
npm run build:ui   # once — the web UI is served from a built bundle
```

The UI bundle is **not** committed (`src/ui/app/dist/` is gitignored — it is
generated, and several people editing the app at once would conflict on it
every merge). If you skip the build, the UI server says so and exits rather
than serving a blank page.

## Running from the checkout

The source tree runs through `tsx`; no build step for the CLI or MCP server:

```bash
npx tsx src/cli.ts --help        # the CLI
npx tsx src/mcp.ts               # the MCP stdio server
npm run dev:all                  # API on :4400 + hot-reloading UI on :4401
npm run dev                      # build the UI + serve http://localhost:4400 (--hub)
```

Handy alias while developing: `alias staple="npx tsx $(pwd)/src/cli.ts"`.

To point a harness at your checkout instead of the published package:

```bash
claude mcp add staple-dev -e STAPLE_AGENT=claude -- npx tsx <checkout>/src/mcp.ts
```

Note: until the first release tag is published, `npx staple-cli` does not
resolve on npm — the checkout (or a locally built package, below) is the only
way to run staple. Releases are cut by CI from version tags; see
[RELEASING.md](RELEASING.md).

## Seeded demo

Play with staple's own build plan (two workspaces, a cross-link) without
touching your real home:

```bash
export STAPLE_HOME=/tmp/staple-demo
npm run seed-demo
npx tsx src/cli.ts inbox --ws staple
npm run dev
```

Pages served to loopback carry their own token, so the browser never sees a
token screen. The token (for curl/agents/remote) lives in
`$STAPLE_HOME/ui-token` (0600) and survives restarts; delete it to rotate.
`/api/*` always requires it; writes are Origin-checked.

## Gates

Run all of these before sending a change; CI runs the same set:

```bash
npm test                # vitest — semantics, CLI JSON, UI auth, takeover drill, tarball acceptance
npm run typecheck       # tsc over the server code and the UI app
npm run smoke:mcp       # full MCP JSON-RPC workflow over stdio
npm run validate:timing # controlled timing runs (design/timing-semantics.md), also part of npm test
```

## Working on the web UI

```bash
npm run dev:all  # the pair: API on :4400 + hot-reloading app on :4401
```

That is the loop you want while editing the app — open http://localhost:4401/
and edits under `src/ui/app/` hot-reload. Ctrl-C stops both halves.

The two halves also run separately, which is only worth doing if you want the
server under a debugger or on a different home:

```bash
npx tsx src/cli.ts open --hub    # the API, on :4400
npm run dev:ui                   # Vite on :4401, proxying /api to it
```

`dev:ui` starts no server of its own — on its own it renders `HTTP 500` over a
wall of ECONNREFUSED, because its proxy target is empty. Start the server first.

Neither dev path touches the static bundle. `npm run build:ui` is what refreshes
the bundle the real `:4400` page serves, and `npm run dev` rebuilds it and
serves it — that is the "what ships" check, not the edit loop.

Adding a setting to *Work Workspace Settings* needs no change to the app: the
navigation, the control and the validation all come from the registry entry.
The checklist — definition fields, choosing the scope, when a workspace
migration is required, which pinned inventories move, which tests to add — is
[design/configuration.md → Adding a setting](design/configuration.md#adding-a-setting).

## Building and drilling the package

```bash
npm run build:package   # -> dist-package/, a complete, publishable npm package
npm run pack:package    # the same, plus `npm pack` -> dist-package/staple-cli-<version>.tgz
npm run drill:npx       # clean-machine drill: pack, install into an empty prefix, exercise the bin
```

`scripts/build-package.ts` bundles `src/package/staple.ts` with esbuild into
one ESM file; the generated `dist-package/package.json` is the published
metadata (name `staple-cli`, bin `staple`, `dependencies: {}`). The drill is
the npx contract: it must pass with nothing but Node — no checkout, no `tsx`,
no build tools — available to the installed binary.

`npm test` does not need `dist-package/`. The suites that install or pack the
real artifact get a payload the test run builds for itself, from the current
source, before any test file loads (`test/setup/package-payload.ts`).

To try the packaged binary directly:

```bash
node dist-package/staple.mjs --help
```

## The website

`site/` is a Docusaurus site and its own npm package, with its own
`package-lock.json`, so the published `staple-cli` package and its dependency
tree never see it. The root scripts delegate to it:

```bash
npm run site:install  # npm ci inside site/ (once, and after its lockfile changes)
npm run site          # dev server with live reload
npm run site:build    # static build into site/build
```

The docs pages are `docs/*.md`, rendered in place (the docs plugin reads
`../docs`); never copy them into `site/`. Contributor material (protocols, schemas,
storage, internal modules) goes in `design/`, never in `docs/`. The build fails on a broken link or a
broken Markdown link. A Markdown link from `docs/` to a `.md` file git tracks
outside `docs/`, such as `../CONTRIBUTING.md`, becomes a link to that file on
GitHub; link any other repository file by its full GitHub URL, since Docusaurus
publishes a relative link to a non-Markdown file as a site asset. The base path is
the `baseUrl` constant at the top of `site/docusaurus.config.ts`; the site URL
comes from the `SITE_URL` environment variable (see below), and local builds use a
placeholder.

### Choosing the landing page

The site has five landing pages, all in `site/src/components/landing/`:
`Story.tsx` leads with why staple exists and how a plan becomes tickets,
`Classic.tsx` is the first landing page, a tour of the features, and three are
experiments: `Bento.tsx` has serif headlines, a dashed drafting grid and a grid of
cells that each show one feature with an animated scene, `Walkthrough.tsx`
has a centred hero in a heavy sans, three steps in one box, and then one feature
per section, each with one animated scene in a panel beside its copy, and
`Blend.tsx` sets the serif headlines on the drafting grid and walks through the
features one at a time beside a feature index that stays in view. The pieces the
experiments share are in `site/src/components/landing/parts/`. The
`LANDING_VARIANT` environment variable decides which one `/` serves: `story` (the
default when it is unset), `classic`, `bento`, `walkthrough` or `blend`. Any other
value fails the build. Every variant stays reachable for comparison: `/story`,
`/classic`, `/bento`, `/walkthrough` and `/blend` always serve their variant,
marked `noindex` and left out of the sitemap.

```bash
npm run site:build                              # / serves the story page
LANDING_VARIANT=classic npm run site:build      # / serves the classic page
LANDING_VARIANT=bento npm run site:build        # / serves the bento page
LANDING_VARIANT=walkthrough npm run site:build  # / serves the walkthrough page
LANDING_VARIANT=blend npm run site:build        # / serves the blend page
```

To switch the deployed site, set the repository variable `LANDING_VARIANT`
(Settings, Secrets and variables, Actions) to one of those names and run the
Site workflow again. The workflow passes it to the build the way it passes
`SITE_URL`; no code change is needed.

### Deploying the website

`.github/workflows/site.yml` builds the site on every pull request that touches
`site/`, `docs/`, a Markdown file at the repository root or the workflow itself,
into any base branch, and runs `wrangler deploy --dry-run` against the output. It never deploys from a pull
request. On master it builds the site and deploys it to Cloudflare as the
`staple-site` Worker, which serves `site/build` as static assets
(`site/wrangler.jsonc`). The sync Worker in `worker/` is separate.

Until the Cloudflare secrets exist, the deploy job skips with a notice and passes.
To turn it on:

1. Create a Cloudflare API token from the "Edit Cloudflare Workers" template,
   for the account and all zones (it includes Workers Scripts: Edit, which the
   deploy and the workers.dev subdomain lookup use).
2. Add two repository secrets (Settings, Secrets and variables, Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Deploy: run the Site workflow on master from the Actions tab
   (Run workflow), or push a change under `site/` or `docs/` to master. The first
   deploy creates the Worker at
   `https://staple-site.<account subdomain>.workers.dev`; the workflow looks the
   subdomain up and builds the site with that URL.

To serve the site on a custom domain:

1. In the Cloudflare dashboard, open the `staple-site` Worker, then Settings,
   Domains and Routes, and add the domain as a Custom Domain (its zone must be on
   the same account). `site/wrangler.jsonc` declares no routes, so later
   deploys leave the domain in place.
2. Set the repository variable `SITE_URL` to `https://<the domain>` (scheme and
   host, no path). This is the one value that moves the site: canonical links,
   the sitemap and social cards use it from the next deploy. Run the workflow
   again to rebuild.
3. The workers.dev address keeps serving the site. To turn it off, set
   `workers_dev` to `false` in `site/wrangler.jsonc`.

Nothing account-specific (account id, zone id, domain) belongs in the repository.
