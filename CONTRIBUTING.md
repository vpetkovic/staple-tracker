# Contributing to staple

This guide is for people hacking on staple itself. If you just want to *use*
staple, you never need any of this — the entire install is
`npx staple-cli` (see the [README](README.md)).

Reference material on how staple behaves — semantics, the agent surface,
continuity, configuration, migration, packaging — lives in [docs/](docs/).

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
[docs/configuration.md → Adding a setting](docs/configuration.md#adding-a-setting).

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

To try the packaged binary directly:

```bash
node dist-package/staple.mjs --help
```

## The website

`site/` is a small static site (plain HTML + one stylesheet), served and built
with Vite:

```bash
npm run site         # dev server
npm run site:build   # static build
```

Edit the HTML in place — there is deliberately no site framework.
