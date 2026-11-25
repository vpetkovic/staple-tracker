# Provider integrations

Staple links existing provider issues and pull requests to local tickets. A link preserves the
provider URL and scoped identity; it does not merge tickets. Multiple tickets can reference the
same source, and one ticket can reference sources from several providers.

GitHub CLI, the Linear GraphQL API and the ClickUp REST API support live reads. Azure DevOps adapters follow later.

## Connect GitHub

Install `gh` on the computer running Staple and authenticate there with `gh auth login`.
Open **Settings → Integrations**. Staple notices the sign-in and offers **Connect as <account>**;
**Add connection** covers another account or a GitHub Enterprise host. Staple reuses the effective
CLI authentication, including environment-token precedence. It refuses an unexpected account and
never changes CLI authentication or extracts a token.

Connections belong to the computer, not to a workspace: one list serves every workspace, and
another machine needs its own. Each connection shows its status at all times (Connected, Sign-in
needed, Wrong account, No access, Rate limited, Offline, CLI missing). The screen rechecks when
it opens and every two minutes while it is visible; **Check now** rechecks everything and the
icon on a row rechecks one. A connection that is not working says what is wrong and what to do,
with the command to copy where there is one. Checking a connection does not change it.

## Choose what each workspace searches

Under **Workspaces** on the same screen, each workspace lists its sources: GitHub repositories,
Linear teams and Linear projects, and ClickUp spaces and lists. **Add** opens a searchable list of what your connections can
read; adding or removing a source saves at once and syncs with that workspace. Search and linking
follow these sources:

- a workspace with sources searches and links only those;
- a workspace with none searches everything chosen for any workspace on this computer;
- **All workspaces** searches everything chosen;
- with nothing chosen anywhere there is no live search, and an exact pasted URL still links.

Search never covers all of GitHub.

## Link an issue or pull request

Open the link dialog from a task's **Linked issues** or **Pull requests** row, the **External
links** tab, or the command palette. The task you opened it from is the target, shown in the
header and changeable there. Type to search every source in scope, or paste an exact HTTPS URL.
The scope control states what is being searched and can narrow to one source. Results show their
state, their key and whether they are already linked here or to another task. **Enter** links the
selected result and the dialog stays open for the next one; **Undo** removes a link just made.
A source that cannot be reached is named in one line while the rest of the results still show.
An item from a repository, team or project outside the workspace's sources is refused, with the
offer to add that source and link.

Search does not import work. Earlier AI migrations can be matched by a retained scoped identity
or full source URL, including completed tickets. Similar titles never establish identity.

**Create task from this** copies an issue's title and body once and requires a stable retry key.
If a task for it may already exist, Staple shows the matches and asks before creating another.
Creation never adds the task to the pickup queue. Pull requests attach to existing tasks as
references.

## Connect Linear

Create a personal API key in Linear's **Settings → Security & access** with read access to the
teams you want to use. Set it in the environment of the process running Staple, then restart that
process. For a background service, configure its environment privately. Never pass the key as a
CLI argument or paste it into a connection form.

Use [Linear's GraphQL explorer](https://studio.apollographql.com/public/Linear-API/variant/current/explorer)
to run `query { viewer { id } organization { id urlKey } }` with that key to find your user and
organization ids. In **Settings → Integrations**, choose **Set up** on the Linear row (or **Add
connection → Linear workspace**), enter the environment variable name and the two ids, and save.
Then add teams or projects to a workspace under **Workspaces**. Staple checks the key's user and
organization on every response. A revoked key or changed account fails without replacing the
saved copy.

The key value stays server-side. Only the variable name and expected identity are saved in a
machine-local connection file. Use different variable names for different accounts. Organization
UUIDs scope team preferences; old GitHub repository preferences and browser defaults still work.

```sh
# Connections belong to this computer; every workspace uses them.
staple integrations configure --provider linear \
  --account USER_UUID --scope ORGANIZATION_UUID --credential-env STAPLE_LINEAR_API_KEY --json
staple integrations containers --connection CONNECTION_ID --json                          # teams
staple integrations containers --connection CONNECTION_ID --container-kind project --json  # projects
staple integrations map --ws my-workspace --connection CONNECTION_ID --container TEAM_UUID --json
staple integrations search --ws my-workspace --text login --json
staple integrations preview --ws my-workspace --connection CONNECTION_ID --container TEAM_UUID --key ENG-123 --json
staple integrations link --ws my-workspace --ref ABC-12 \
  --url https://linear.app/my-workspace/issue/ENG-123/example --confirmed --json
staple integrations refresh --ws my-workspace --resource RESOURCE_ID --json
```

Paste an exact issue URL in the link dialog, or type to search the mapped teams and projects,
most recently updated first, with **Show more** for further pages. An empty field lists recent
issues. Linear preserves native workflow states and uses organization, team and issue UUIDs for
identity. Issue identifiers and URL slugs are display context. Linear has no PR capability; GitHub
PRs can coexist with Linear issues on the same Staple ticket, and the **Pull requests** filter
skips Linear sources.

Requests use the fixed `https://api.linear.app/graphql` endpoint, a 15-second timeout, a 2 MB
response limit and 50 items per page. Cursors are bound to the connection and search. Authentication,
permission, rate-limit and GraphQL failures return redacted messages. No provider writes, automatic
synchronization or outbound projection are included.

Sources: [GraphQL API](https://linear.app/developers/graphql), [TypeScript SDK](https://linear.app/developers/sdk).

## Connect ClickUp

Create a personal API token in ClickUp under **Settings → Apps** (it starts with `pk_`). Set it in
the environment of the process running Staple, then restart that process. Staple only reads with
it. Never pass the token as a CLI argument or paste it into a connection form.

Your workspace ID is the number after `app.clickup.com/` in any ClickUp page's address. In
**Settings → Integrations**, choose **Add connection → ClickUp workspace**, enter the environment
variable name and the workspace ID, and save. Staple checks that the token can see that workspace,
and every task it reads must belong to it. Then add spaces or lists to a workspace under
**Workspaces**.

```sh
staple integrations configure --provider clickup   --scope WORKSPACE_ID --credential-env STAPLE_CLICKUP_API_TOKEN --json
staple integrations containers --connection CONNECTION_ID --json                       # spaces
staple integrations containers --connection CONNECTION_ID --container-kind list --json  # lists, one space per page
staple integrations map --ws my-workspace --connection CONNECTION_ID --container SPACE_ID --json
staple integrations search --ws my-workspace --text importer --json
staple integrations preview --ws my-workspace --connection CONNECTION_ID --container WORKSPACE_ID --key DEV-42 --json
staple integrations link --ws my-workspace --ref ABC-12 --url https://app.clickup.com/t/86abc123 --confirmed --json
```

A task is identified by its workspace and task id, so moving it between lists or spaces keeps its
links. Paste a task URL (`https://app.clickup.com/t/86abc123`, or `/t/WORKSPACE_ID/DEV-42` for a
custom id), or type a task id or custom id to find it wherever it is. Custom ids are display keys.
ClickUp's API has no text search, so typing matches task names, custom ids and ids over the most
recently updated tasks in the mapped spaces and lists, three provider pages (300 tasks) at a time;
**Show more** reads further back. An empty field lists recent tasks.

The saved copy keeps the task's native status and adds a short **ClickUp** block under the
description: the space, folder and list it lives in, where its status sits among that list's own
statuses, assignees (user names only), its parent and subtasks, the tasks it is waiting on or
blocking, and linked tasks. None of this changes a Staple ticket's status or dependencies.

Requests use the fixed `https://api.clickup.com/api/v2` endpoint, a 15-second timeout and an 8 MB
response limit. ClickUp allows 100 requests a minute per token on most plans. Staple keeps one budget
per token on the computer running it, adopts the limit ClickUp reports, waits up to five seconds when
the budget is nearly free, and otherwise reports **Rate limited** with ClickUp's own retry time
(`Retry-After`, else `X-RateLimit-Reset`). A read that would need more requests than remain fails
whole; it never returns a partial page. ClickUp answers an unknown task id with the same 401 it uses
for a workspace the token cannot see, so that reads as not found, while a missing, invalid or revoked
token reads as **Sign-in needed**. No provider writes, automatic synchronization or status and
dependency projection are included.

Sources: [API reference](https://developer.clickup.com/reference/getfilteredteamtasks),
[rate limits](https://developer.clickup.com/docs/rate-limits), [errors](https://developer.clickup.com/docs/common_errors).

## Local execution and cached context

Staple remains authoritative for execution status, claims, descriptions, gates and queue order.
Refreshing updates separate provider context. Unlinking removes only an association. The
integration makes read-only provider requests; it cannot create, close or merge PRs, post comments,
change remote status, rebase or restack branches.

Links sync with a connected workspace. Cached title/body/status stay private to the fetching
machine until a person explicitly enables source-context sharing. The choice applies to that
source across its linked tickets. Turning sharing off clears the current shared copy while
preserving local cache; retained operation history and backups may still contain earlier shared
context. Provider credentials and account bindings never enter workspace replication.

The UI calls this the saved copy. It shows the copy's age and marks one older than 24 hours.
A failed refresh preserves the saved copy. A cloud-only session can show synced links and
consented context, but live reads need a connection on the machine running Staple. There is no cloud-to-desktop execution bridge,
hosted provider credential store or scheduled provider refresh in this version.

The **External links** tab lists a task's links by repository or team, one row each, with state,
key and the age of the saved copy. A row opens in place for the description, **Stacked on**, the
sharing switch and **Unlink**. Only an explicit **Stacked on** choice forms a stack, drawn as
indented rows; a parent that is not linked to the task stays labelled, and PR numbers and branch
names never imply ancestry. **Stacked on** changes Staple references only.

## CLI and MCP

```sh
# Connections and their health are per computer, so these take no workspace.
staple integrations configure --host github.com --account my-account --json
staple integrations connections --json
staple integrations health --connection CONNECTION_ID --force --json

# What each workspace searches and links. The mapping syncs with the workspace.
staple integrations containers --connection CONNECTION_ID --text api --json
staple integrations map --ws my-workspace --connection CONNECTION_ID --container REPOSITORY_ID --json
staple integrations mapping --ws my-workspace --json
staple integrations mapping --all-workspaces --json
staple integrations unmap --ws my-workspace --target-key github.com/REPOSITORY_ID --json

# Search and link inside that scope; --all-workspaces spans every mapping on this computer.
staple integrations search --ws my-workspace --text login --json
staple integrations search --ws my-workspace --all-workspaces --text login --json
staple integrations preview --ws my-workspace --url https://github.com/owner/repo/issues/42 --json
staple integrations link --ws my-workspace --ref ABC-12 --url https://github.com/owner/repo/issues/42 --confirmed --json
```

A workspace with a mapping searches and links only its mapped repositories, teams, projects, spaces and lists. A
workspace with no mapping, and `--all-workspaces`, cover everything mapped on this computer. With
nothing mapped anywhere, search reads cached context only and an exact URL still links. Search runs
once per mapped source; a source that fails is reported in `failures` beside the others' results.
Linking outside the scope is refused with `outside_scope` and names the repository or team to map.

`staple integrations --help` lists the available operations. MCP exposes `integration_read`,
`integration_write` and `configure_integration` through the same operation service, with the same
fields (`allWorkspaces`, `containerKind`, `targetKey`, `containerKey`). Configure is machine-local;
mapping and link/context writes sync with the workspace.

## Add a provider or API transport

Implement `IntegrationAdapter` in `src/core/integrations/contracts.ts` and register its factory at
the shared operations boundary. An adapter supplies health, container discovery, paginated issue
search, exact URL/key resolution, detail reads and optional PR reads/search. Unsupported PR search
must remain explicit; exact PR references can still be linked without metadata support.

For a direct GitHub API transport, preserve the existing `providerId`, normalized host, stable
scope, numeric repository id, resource kind and issue/PR number. Account names, display keys,
repository names and transport mode are not identity. The CLI and API modes must converge on the
same resource. An HTTP SDK does not supply credential consent, hosting or account lifecycle.

Before enabling another adapter:

- Validate configured hosts and returned scope/identity, canonical safe URLs and resource kind.
- Bound I/O, output size, timeouts and pagination; bind opaque cursors to the original query.
- Translate health/rate-limit failures without returning tokens, raw stderr or private bodies.
- Keep account bindings/credentials machine-local; use the shared linking, matching, creation and
  replication services rather than implementing parallel persistence.
- Test exact identity, rename, repeated/concurrent create, many-to-many links, close/reopen,
  missing CLI or revoked access, stale/offline cache and two-device convergence.
- Verify keyboard/touch, long names, bounded row/property previews and deep/missing-parent stacks.

Outbound provider changes, OAuth/API hosting, comment/attachment mirroring and fuzzy task merging
require separate product decisions.
