# Machine configuration

Everything staple keeps per-machine — `hub.db`, the UI token, `config.json`,
and global workspaces — lives in one directory, the **staple home**. It is
resolved in exactly one place (`src/config/`), in this order:

| # | Source | Notes |
|---|---|---|
| 1 | `--home <path>` | Configuration and diagnostic commands only, not a global flag |
| 2 | `STAPLE_HOME` | Wins over the locator; handy for tests and portable setups |
| 3 | Bootstrap locator | Written by `staple config home`; see the table below |
| 4 | `~/.staple` | The default when nothing else says otherwise |

The **bootstrap locator** deliberately lives *outside* the home, because a file
that says where the home is cannot live inside it:

| Platform | Locator |
|---|---|
| macOS | `~/Library/Application Support/Staple/bootstrap.json` |
| Linux | `$XDG_CONFIG_HOME/staple/bootstrap.json`, else `~/.config/staple/bootstrap.json` |
| Windows | `%APPDATA%\Staple\bootstrap.json` |

Schema v1 is `{ "schemaVersion": 1, "home": "<absolute-path>" }`, written 0600
in a 0700 directory. A relative path, a filesystem root, or an unknown
`schemaVersion` is refused rather than guessed at; an *absent* locator is not an
error, it just means `~/.staple`.

## `config.json`

`<home>/config.json` holds durable preferences only — never per-project state,
which belongs in the workspace database.

```jsonc
{
  "schemaVersion": 1,
  "browser": "auto",        // auto | always | never
  "port": 4400,             // preferred UI port
  "setupComplete": false,
  "connectors": {}          // reserved for future connector receipts
}
```

Three properties are load-bearing:

- **Sparse.** Only keys you actually set are written. Defaults stay live, so
  changing a default later still reaches machines that ran `config set` once.
- **Forward-compatible.** Keys written by a newer staple are preserved untouched
  across a rewrite by an older one, instead of being silently dropped.
- **Refused, not replaced.** A corrupt file or a newer `schemaVersion` is a hard
  validation error naming the path. Falling back to defaults would read as
  robustness and behave as data loss — the next write would overwrite the file.

Both files are written through a validated temporary file in the same directory
and then `rename(2)`d over the target, so a reader sees the old bytes or the new
bytes, never half of each.

## Commands

```bash
staple config                       # effective settings and where each came from
staple config --json                # the same, machine-readable
staple config set port 4500         # browser | port | setupComplete
staple config home /vol/staple --move --yes
```

`config` prints one setting per line with the key in a fixed 14-column field:

```
home          /Users/you/.staple  (default)
config        /Users/you/.staple/config.json  (absent)
locator       /Users/you/Library/Application Support/Staple/bootstrap.json  (absent)
browser       auto  (default)
port          4400  (default)
setup         incomplete  (default)
```

The source label is the point: `default`, `config`, `env`, `locator`, or `flag`.
A `4400` you chose and a `4400` you inherited are different facts.

## Moving the home

Changing the home once data exists is a migration, not a key assignment:

```bash
staple config home /Volumes/work/staple --move --yes
```

It requires an absolute path, refuses a filesystem root, refuses a non-empty
destination rather than merging into it, and refuses a destination nested inside
the source. It checkpoints the databases, copies, **verifies the destination,
and only then** updates the bootstrap locator — so a failure anywhere leaves the
old home live and untouched. The old home is *retained* afterwards; delete it
once you have confirmed the new one works.

Two things it will tell you about rather than silently paper over:

- If `STAPLE_HOME` is set, it outranks the locator, so the move you just made
  will not take effect until you unset it. You get a warning.
- Hub registrations that point *inside* the old home are reported, not rewritten
  — repointing them is `staple init` in the affected workspace.

## Diagnosis

```bash
staple doctor                       # read-only: home, config, hub, workspace, schema,
                                    # migration journals, UI port, runtime, assets
staple doctor --json
staple doctor --fix --only <check> --yes
```

`doctor` exits 1 when a check fails and prints the exact repair command. A bare
`--fix` is refused with or without `--yes`; `--only` without `--yes` previews.
A failed migration additionally needs `--keep legacy|new`.
