---
title: Errors and exit codes
description: Every error code and exit status staple returns, what each means, and what to do about it.
---

# Errors and exit codes

Use this page when a command or a tool refuses and you want to know why and what to
do next, or when a script needs to branch on the result. Every error has a `code`,
and on the CLI each code has its own exit status.

## Reading an error

1. At a terminal, an error is one line on stderr: `error(<code>): <message>`. The
   message says what to do.

   ```text
   error(gated): APP-4 is queued behind APP-1, awaiting approval by VP. Pick a different task — approval is a human action, not a retry.
   ```

2. With `--json`, the same error is one JSON object on stderr. The MCP server returns
   the same object in an `isError` result.

   ```json
   {"code":"out_of_order","message":"APP-4 is later in the queue than APP-5, which is ready. Take APP-5, or ask a human to reorder or override.","detail":{"policy":"strict","expected":["APP-5"],"position":2,"expectedPosition":1},"retryable":false}
   ```

3. Check `retryable`. Only `revision_conflict`, `timeout`, `rate_limited`,
   `unavailable` and `offline` are worth trying again; retrying anything else gives
   the same answer.
4. In a script, branch on the exit status (`$?`) rather than parsing the message.

## Exit codes

| Exit | Code | What it means | What to do |
|---|---|---|---|
| 0 | | It worked | |
| 1 | `unknown` | Something failed that staple has no code for, or `staple doctor` found a failing check | Read the message; `staple doctor` prints the fix for a failing check |
| 2 | `validation` | The input is wrong: an unknown flag, kind, status or setting value, a bad duration. A preview that needs `--yes` (for example `install`, `add`, `config home --move`, `budget setup`, `budget forget`) also exits 2 and changes nothing | Fix the input the message names, or add `--yes` after reading the preview |
| 3 | `not_found` | No such ticket, document, workspace, run or reading | Check the reference with `staple ls` or `staple hub`, or pass `--ws` |
| 4 | `conflict` | Someone else got there first: the ticket is claimed, its status does not allow the move, or it still has unresolved blockers | Pick a different ticket. Do not retry |
| 5 | `duplicate` | An open ticket with this title already exists under the same parent, or the status or kind already exists | Use the existing one, or pass `--allow-duplicate` to `staple new` |
| 6 | `cycle` | The blockers you set would make tickets wait on each other in a loop | Remove one of the blockers |
| 7 | `revision_conflict` | Someone changed the document, queue or milestone order since you read it (`--base N`) | Read it again, merge your change, and retry |
| 8 | `timeout` | `staple wait` ran out of time; nothing failed | Wait again with a longer `--timeout` |
| 9 | `gated` | The ticket is held by an [approval gate](approval-gates.md) above it | Pick a different ticket. The gate's owner runs `staple approve` |
| 10 | `out_of_order` | `queue.policy` is `strict` and the [pickup queue](queue.md) puts another ticket first | Take the ticket in `detail.expected`, or a person uses `checkout --override -m <why>` |

These come only from [cloud sync](cloud-sync.md) (`staple cloud …` and
`staple hub registry …`):

| Exit | Code | What it means | What to do |
|---|---|---|---|
| 11 | `auth` | The credential is missing or invalid | Connect again with `staple cloud connect` |
| 12 | `forbidden` | This machine is not a member, or a consent is missing (backups need `staple cloud backup enable`) | Use the right token, or give the consent the message names |
| 13 | `revoked` | This machine was revoked | Connect again with a new token |
| 14 | `epoch_changed` | The repository was restored again while this machine was catching up with it | Run `staple cloud sync` again once nobody is restoring |
| 15 | `cursor_invalid` | This machine's sync position belongs to another repository or cannot be read | Run `staple doctor`. A workspace copied from another one needs `staple cloud fork-id` |
| 16 | `payload_too_large` | A change is bigger than the service accepts | Shorten the description, comment or document the message names |
| 17 | `schema_ahead` | Another machine wrote data with a newer staple | Upgrade staple on this machine |
| 18 | `protocol_unsupported` | This staple and the service have no version in common | Upgrade staple, or the service |
| 19 | `rate_limited` | The service asked you to slow down; `detail.retryAfter` says how long | Try again after that |
| 20 | `unavailable` | A passing failure on the service | Try again later |
| 21 | `offline` | The service could not be reached. Local work carries on | Try again when you are online |

## Retrying in a script

Retry only on 19, 20 and 21. Do not use a range such as `-ge 19`: statuses above 21
are not staple's. The installed launcher exits 70 when no runtime is installed (run
`staple install --yes`), and a signal gives 128 plus its number (130 for Ctrl-C). A
loop that retried on those would never stop.

```sh
staple cloud sync
case $? in
  19|20|21) echo "try again later" ;;
esac
```

Going deeper: [the CLI in detail](../design/cli.md#machine-readable-output) covers
the error object's fields, and [the sync design](../design/sync.md#error-taxonomy)
the cloud codes.
