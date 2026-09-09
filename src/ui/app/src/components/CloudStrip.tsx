/**
 * Cloud state, when there is any. Nothing at all when there is not.
 *
 * ## The default is to render nothing, and that is the whole component
 *
 * `docs/sync.md`: *"Before connect — render 'not connected' and a static hint
 * naming `staple cloud connect`. Static text. No probe, no reachability check,
 * no 'we noticed you might want to connect'. **The UI does not prompt.**"*
 *
 * The contract permits a static hint. This declines it. Every workspace is
 * disconnected until somebody types a command, so a hint here would be a
 * permanent advertisement on every page of every install for a feature the user
 * has not asked for — and the epic's first invariant is that an unconnected
 * workspace is indistinguishable from one built before the feature existed.
 * `report.hint` is carried on the contract and deliberately never read here.
 *
 * The precedent is `FilterChips`, directly above this in `AppShell`: it renders
 * no border and no height when no filter is on, because the app's usual state
 * should cost nothing. This is the same idea applied to a stronger requirement.
 *
 * ## Why this component cannot cause a network call
 *
 * It takes a report as a prop and performs no fetch. The one request behind it
 * is `AppShell`'s single call to `/api/cloud/status`, which is same-origin
 * loopback to the local server, and that route reads three files and a local
 * database — *"it deliberately has no `refresh` parameter"*, because *"a polled
 * UI with a refreshing status endpoint would turn one human's page-open into a
 * heartbeat to Cloudflare every few seconds."*
 *
 * That call is made ONCE per mount rather than on the 1.5s fingerprint poll.
 * Connection state changes when a human runs a command, not while they read a
 * page, so polling it would be a great deal of traffic to learn nothing — and it
 * is the shape most likely to be quietly upgraded into a probe later.
 *
 * ## Values, not prose
 *
 * Everything below reads a value off the report — `mode`, `pending`, `cursor`,
 * `conflicts.open` — and never parses `detail`. `detail` and `failure.summary`
 * are for humans; a component that inferred state from a sentence would break
 * the first time the sentence was improved.
 */
import type { CloudSurfaceReport } from "@/lib/types";

/**
 * One label/value pair. Rendered only when the value is worth a reader's
 * attention — a null cursor and a zero pending count are true, and are also
 * noise on a strip that has to earn its row of vertical space.
 */
function Fact({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}

export function CloudStrip({ report }: { report: CloudSurfaceReport | null }) {
  /**
   * The two silences, together, because they are the same statement.
   *
   * `null` is "the status has not arrived yet" and `disconnected` is "there is
   * nothing to say". Rendering a skeleton for the first would flash cloud
   * furniture onto every page load on a machine that has no cloud, which is the
   * invariant broken by a loading state instead of by a feature.
   */
  if (report === null || report.state === "disconnected") return null;

  const { failure } = report;

  return (
    <div
      data-cloud-strip
      className="flex shrink-0 items-center gap-3 border-b px-4 py-1 text-[11px] text-text-secondary"
    >
      <Fact label="sync" value={report.mode} />
      <Fact label="device" value={report.label ?? report.deviceId} />
      {/* Zero pending is the healthy resting state and needs no row. */}
      <Fact label="pending" value={report.pending > 0 ? String(report.pending) : null} />
      <Fact label="cursor" value={report.cursor} />
      <Fact label="epoch" value={report.epoch === null ? null : String(report.epoch)} />
      <Fact
        label="conflicts"
        value={report.conflicts.open > 0 ? String(report.conflicts.open) : null}
      />
      {/*
        Leases held, but only when some are. `docs/sync.md` is emphatic that a
        local checkout and a distributed lease are different things; a count of
        zero is the ordinary case and saying so every time would flatten the
        distinction rather than sharpen it.
      */}
      <Fact label="leases" value={report.leases.held > 0 ? String(report.leases.held) : null} />

      {failure ? (
        /*
          The one thing allowed to be loud — and it carries its remedy, because a
          reported failure a reader cannot act on is worse than no report. `role`
          is status rather than alert: `offline` is an ordinary condition on a
          train, and interrupting a screen reader for it would be a lie about
          severity.
        */
        <span role="status" className="ml-auto truncate text-text-primary">
          {failure.summary} {failure.remedy}
        </span>
      ) : null}
    </div>
  );
}
