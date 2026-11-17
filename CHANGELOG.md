# Changelog

## 0.2.0

- Ship the accumulated changes since 0.1.0, including MCP Apps conversation views,
  experimental idea and horizon planning, and workspace discovery from linked Git
  worktrees. Planning stays off by default and only a person can enable it.
- Provide a portable Staple agent skill in `skills/staple`, in both the repository
  and the npm package. See the [installation guide](docs/connect-your-agent.md#install-the-reusable-staple-skill).
- Run the package build, Worker checks and isolated tests in the release gates,
  matching the checks on pull requests.
- Report the built package version in the MCP handshake, instead of always
  reporting 0.1.0.

Upgrade with `npx -y staple-cli@0.2.0 --version`, then use that version for your
normal commands. To update a managed installation, run
`npx -y staple-cli@0.2.0 install --yes`. Restart long-running MCP servers to load
the new runtime, and update any installed Staple skill from the same release.

This runtime understands workspace schema 21 and hub schema 8. Opening an older
database can migrate it after taking an automatic snapshot. Keep that snapshot
and the retained prior runtime. `staple install --rollback --yes` selects a prior
runtime; it does not undo database migrations. See [migration and recovery](design/migration.md)
before rolling back an upgraded workspace. Never restore a snapshot over newer work.

## 0.1.0

First public npm release, published October 1, 2026.
