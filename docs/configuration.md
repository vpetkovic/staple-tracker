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

## The settings registry

Every setting staple has — machine preference or workspace setting — has one
typed definition in `src/core/settings-registry.ts`: a namespaced key
(`category.name`), a category, a value schema, a default, a **scope**, a
version with an optional migrate hook, a sensitivity flag, and the label,
description and control the UI renders it with. Nothing else carries a second
copy of a default or a value check; the config file, the workspace store, the
CLI and `/api/settings` all validate through the registry, on read *and* on
write, and refuse with a sentence that names the key.

Scope is physical, not a label:

| Scope | Lives in | Written by | Examples |
|---|---|---|---|
| `global` | `<home>/config.json`, under the field the definition names | `staple config set` | `machine.browser`, `machine.port`, `machine.setupComplete` |
| `workspace` | the workspace database (`meta` rows keyed `setting:<key>`) | `staple settings set`, `set_setting`, `POST /api/settings` with `target: "settings"` | `kinds.default`, `queue.policy` |

A workspace key is refused on the config surface and a global key is refused
on the workspace surface, each refusal naming the surface that does own it.

### `queue.policy`

The first registered feature control, in the **Workflow** category (registry
id `queue`, because a key is namespaced by its category). It is defined
exactly as [queue.md](queue.md#policy-advisory-or-strict) names it:
workspace scope, `advisory | strict`, default `advisory`.

- `advisory` — the queue orders and explains; a checkout is never refused for
  order. Upgrading a workspace changes nothing an agent can observe until a
  human sets `strict`.
- `strict` — an agent's checkout of a later item is refused (`out_of_order`,
  exit 10) while an earlier eligible item exists, and the refusal names what to
  take instead. Dependencies, approval gates and live claims stay hard
  constraints under both values.

The registry defines, stores and exposes the value; the checkout resolver
that reads it is R2c's (STA-168), which imports `QUEUE_POLICIES` from the
registry rather than restating the set. The definition's description carries
the side effect, so every surface can show what `strict` changes *before* a
save, and every change is a `setting_changed` event with actor, previous and
new value. The same `{ value, source }` pair is answered by `staple settings
get queue.policy`, the `get_setting` tool, `/api/settings` `values`, and the
UI's `settingValue()` — pinned by `test/contract-settings-surfaces.test.ts`.

Workspace values are stored as `{ "v": <version>, "value": … }`. Reading a
value written at an **older** version runs the definition's migrate hook
(deterministic, no clock, no I/O) or falls back to the default when there is
none; reading one written at a **newer** version is refused rather than
reinterpreted, exactly as `config.json` refuses a newer `schemaVersion`. A
`setting:*` row this build has no definition for is preserved byte for byte
and reported as an unknown key — downgrading never truncates configuration.
Every change logs a `setting_changed` event with the actor, the previous
value and the new one.

The registry also lists the workspace's **categories** — Statuses, Kinds,
Workflow, This machine — with the editor each one needs, so the settings UI
enumerates its navigation from the registry rather than hard-coding tabs.
Adding a setting or a category is a registry entry (plus a field on
`StapleConfig` for a global one); no shell component changes.

Workspace values have their own commands, the workspace twin of `config`:

```bash
staple settings                       # every registered workspace setting: key = value  (source)
staple settings get queue.policy      # one, e.g.  queue.policy = advisory  (default)
staple settings set queue.policy strict
staple settings get queue.policy --json
# {"key":"queue.policy","scope":"workspace","value":"strict","source":"workspace","version":1}
```

`source` is `default` (nothing stored) or `workspace` (someone set it). The
value is coerced and validated through the registry — `queue.policy` takes
only `advisory` or `strict`, exit 2 otherwise — and the write is attributed to
`STAPLE_AGENT` (or `$USER`). A global key such as `machine.port` is refused
here with the sentence naming `staple config set`.

## Adding a setting

A setting is added by *registering* it. There is no shell component to edit, no
tab to add and no client-side copy of the default to keep in step — the
navigation, the control, the scope tag and every surface's validation are all
derived from the definition. Work down this list.

**1. Write the definition** in `src/core/settings-registry.ts`, in
`SETTING_DEFINITIONS`:

| Field | What to put there |
|---|---|
| `key` | `category.name`. **Stable forever** — it is the persistence key. Must be namespaced by an existing category id. |
| `category` | An id in `SETTING_CATEGORIES`. Add one there if the setting is not about anything that already exists. |
| `scope` | `workspace` or `global`. See below; it must match the category's scope. |
| `schema` | One of `boolean`, `integer` (with `min`/`max`), `string` (with `pattern` + `patternHint`), `enum` (with `values`). A new shape is a new arm of `SettingSchema`, never `unknown`. |
| `default` | The value when nothing is stored. It is validated against its own schema at import, so a bad default fails the process rather than the first user. |
| `version` | Starts at `1`. Bump only when the persisted value's **meaning** changes. |
| `migrate` | Optional, and only alongside a `version` bump. Deterministic: same input, same output, no clock, no I/O. |
| `sensitivity` | `normal`, or `sensitive` for a value that must never leave the process on a read surface (the wire view then carries `redacted: true` and no value). |
| `ui` | `label`, `description`, `control` (`toggle`/`number`/`text`/`select`) and `order` within the category. The description is the only place a **side effect** can be stated before Save — say what changes, as `queue.policy` does. |
| `configKey` | Global scope **only**: the top-level `config.json` field the value is stored under. Required for a global setting, forbidden for a workspace one. |

**2. Choose the scope by where the value belongs, not by who edits it.**
A `workspace` setting is a fact about *this project's work* and travels with the
database — every clone and every agent sees it. A `global` setting is a
preference of *this computer* and never leaves it. Ask: would a teammate
opening the same workspace want this value? Yes → `workspace`. Would it be
wrong on somebody else's machine (a port, a browser choice) → `global`. A
global setting also needs its field added to `StapleConfig` in
`src/config/file.ts`; a workspace setting needs nothing outside the registry.

**3. Versioning, and when a workspace migration is required.**

- **Never**, for a new setting. A key with no stored row simply reads its
  default, on every existing workspace, at every schema version. Adding a
  setting is not a schema change: workspace values live in `meta` rows keyed
  `setting:<key>` that the `meta` table has always been able to hold.
- **Never**, for changing a default. Only workspaces that *stored* a value keep
  it; the rest pick the new default up.
- **A `version` bump plus a `migrate` hook**, when the meaning of an existing
  stored value changes (an enum member is renamed, a number changes unit). The
  hook is what reads the old value; without one, an older value is discarded for
  the default. A stored value written at a *newer* version is refused, never
  reinterpreted.
- **A real workspace migration** (`src/core/migrations/workspace/00N-*.ts`),
  only when the *shape of the database* has to change — a new table or column.
  Moving a value into or out of `meta` is such a change; adding a setting is not.

**4. Which pinned inventories change.** Each of these deliberately restates the
whole registered set, so a new entry shows up as a failing test rather than as a
surprise months later. Update them in the same commit:

- `test/settings-registry.test.ts` — "registers the three machine preferences as
  global and two workspace field settings", and, for a new category, "lists
  statuses, kinds and the Workflow category…".
- `test/store-settings.test.ts` — the workspace list read (`settingValues()`).
- `test/characterize-cli-surface.test.ts` — the `staple settings` output.
- `docs/cli.md` and this file, when the setting is one a user is told about.

**5. Which tests to add.** Follow the neighbouring file's style; the harnesses
already exist.

- The definition itself — `test/settings-registry.test.ts`: schema, default,
  scope, and the sentence the description owes the user.
- The value through the store — `test/store-settings.test.ts`: default, set,
  reset, refusal, and the `setting_changed` event.
- All four surfaces agreeing — `test/contract-settings-surfaces.test.ts`, if the
  setting is one agents read.
- The render — nothing, usually. `src/ui/app/src/settings/fields-form.test.tsx`
  already proves that each *schema* renders its control, so a new definition of
  an existing shape needs no UI test. A new `SettingCategoryEditor` does: it is a
  new arm of `CategoryContent`.
- The scope guarantee and the shell as a whole are covered once, for every
  setting, by `test/settings-verification.test.ts` and
  `src/ui/app/src/settings/settings-verification.test.tsx`.

## `config.json`

`<home>/config.json` holds durable preferences only — never per-project state,
which belongs in the workspace database. Its known fields are exactly the
registry's global definitions.

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
