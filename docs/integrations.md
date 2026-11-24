# Provider integrations

Staple links existing provider issues and pull requests to local tickets. A link preserves the
provider URL and scoped identity; it does not merge tickets. Multiple tickets can reference the
same source, and one ticket can reference sources from several providers.

GitHub CLI and the Linear GraphQL API support live reads. Azure DevOps and ClickUp adapters follow later.

## Connect GitHub

Install `gh` on the computer running Staple and authenticate there with `gh auth login`.
Open **Settings → Integrations**, enter the host and expected account, and check the connection.
Staple reuses the effective CLI authentication, including environment-token precedence. It refuses
an unexpected account and never changes CLI authentication or extracts a token.

Use **Find repositories** to choose workspace search scopes. Repository preferences sync with the
workspace. Account bindings remain on this machine. For another machine, configure its own
connection. Missing CLI, authentication, permission, network and version failures have distinct
health states; checking a connection does not change it.

From search/commands, ticket properties, or **External links**, open **Link issue or PR**. Paste an
exact HTTPS URL or search a connected provider. Inspect existing links and exact migration matches,
then select a local ticket and confirm. Search does not import work. Earlier AI migrations can be
matched by a retained scoped identity or full source URL, including completed tickets. Similar
titles never establish identity.

Creating linked work from an issue copies the title/body once and requires a stable retry key.
Existing matches require an explicit choice to create additional work. Creation never adds the
ticket to the pickup queue. PRs attach to existing tickets as references.

## Connect Linear

Create a personal API key in Linear's **Settings → Security & access** with read access to the
teams you want to use. Set it in the environment of the process running Staple, then restart that
process. For a background service, configure its environment privately. Never pass the key as a
CLI argument or paste it into a connection form.

Use [Linear's GraphQL explorer](https://studio.apollographql.com/public/Linear-API/variant/current/explorer)
to run `query { viewer { id } organization { id urlKey } }` with that key to find the expected
user and organization UUIDs. In **Settings → Integrations**, select **Linear API**, enter these
UUIDs and the environment variable name, then **Check connection** and **Find teams**. Staple
checks the key's user and organization on every response. A revoked key or changed account fails
without replacing the saved context.

The key value stays server-side. Only the variable name and expected identity are saved in a
machine-local connection file. Use different variable names for different accounts. Organization
UUIDs scope team preferences; old GitHub repository preferences and browser defaults still work.

```sh
staple integrations configure --ws my-workspace --provider linear \
  --account USER_UUID --scope ORGANIZATION_UUID --credential-env STAPLE_LINEAR_API_KEY --json
staple integrations containers --ws my-workspace --connection CONNECTION_ID --json
staple integrations search --ws my-workspace --connection CONNECTION_ID --container TEAM_UUID --text login --json
staple integrations preview --ws my-workspace --connection CONNECTION_ID --container TEAM_UUID --key ENG-123 --json
staple integrations link --ws my-workspace --ref ABC-12 --connection CONNECTION_ID \
  --url https://linear.app/my-workspace/issue/ENG-123/example --confirmed --json
staple integrations refresh --ws my-workspace --resource RESOURCE_ID --connection CONNECTION_ID --json
```

Paste an exact issue URL in the link dialog, or select a team and enter an exact issue identifier.
Other text searches accessible issues, with paginated results. Empty search browses issues.
Linear preserves native workflow states and uses organization, team and issue UUIDs for identity.
Issue identifiers and URL slugs are display context. Linear has no PR capability; GitHub PRs can
coexist with Linear issues on the same Staple ticket. A **Link PR** shortcut keeps its type and
starts cached-only if the saved connection is Linear.

Requests use the fixed `https://api.linear.app/graphql` endpoint, a 15-second timeout, a 2 MB
response limit and 50 items per page. Cursors are bound to the connection and search. Authentication,
permission, rate-limit and GraphQL failures return redacted messages. No provider writes, automatic
synchronization or outbound projection are included.

Sources: [GraphQL API](https://linear.app/developers/graphql), [TypeScript SDK](https://linear.app/developers/sdk).

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

The UI labels cached context with its fetch time and marks context older than 24 hours stale.
A failed refresh preserves the saved context. A cloud-only session can show synced links and
consented context, but live reads need a connection on the machine running Staple. There is no cloud-to-desktop execution bridge,
hosted provider credential store or scheduled provider refresh in this version.

PRs group by immutable provider scope and repository. Only explicit local parent/order choices
form stacks. Missing parents and unset order stay labelled; PR numbers and branch names never
imply ancestry. The parent/order editor changes Staple references only.

## CLI and MCP

```sh
staple integrations configure --ws my-workspace --host github.com --account my-account --json
staple integrations connections --ws my-workspace --json
staple integrations health --ws my-workspace --connection CONNECTION_ID --json
staple integrations preview --ws my-workspace --url https://github.com/owner/repo/issues/42 --json
staple integrations link --ws my-workspace --ref ABC-12 --url https://github.com/owner/repo/issues/42 --confirmed --json
```

`staple integrations --help` lists the available operations. MCP exposes `integration_read`,
`integration_write` and `configure_integration` through the same operation service. Every client
must target the intended workspace. Configure is machine-local; only link/context writes trigger
consented automatic workspace sync.

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
