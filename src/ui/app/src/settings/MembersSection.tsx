/**
 * SETTINGS → MEMBERS: the people who share this workspace, their devices, and the
 * requests waiting to join.
 *
 * Two components, the split `CloudSection` uses. `MembersPanel` is a pure function of state
 * and handlers, so the suite (which renders to a string) can pin what an owner sees and what
 * a member sees. `MembersSection` fetches and holds the state.
 *
 * Opening this section fetches from the service every time: it is a person's action, and the
 * list on the service is the authority. Every change here (approve, deny, rename, remove)
 * answers with the refreshed list, which the server has already written to the local cache
 * the rest of the page reads.
 *
 * Owner-only controls are not shown to a member. The service refuses them anyway, and when it
 * does, its sentence is shown as it came.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  approveJoinRequest,
  denyJoinRequest,
  fetchMembers,
  removeMember,
  renameMember,
  revokeMemberDevice,
} from "@/lib/api";
import { setPendingJoinRequests } from "@/lib/pending-requests";
import type { CloudJoinRequest, CloudMember, CloudMemberList, CloudMembersResponse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./form/ConfirmDialog";
import { InviteBox } from "./InviteBox";
import { InlineError, Section } from "./form/primitives";
import {
  approveChoices,
  deviceCount,
  mayRemoveDevice,
  mayRemoveMember,
  mayRename,
  memberInitials,
  memberLastSeen,
  orderMembers,
  relativeTime,
  removeConfirmMatches,
  selfOf,
} from "./members-settings";

/** What one pending request's card has chosen so far. */
export interface ApproveDraft {
  mode: "new" | "existing";
  name: string;
  memberId: string;
}

export interface MembersState {
  list: CloudMemberList | null;
  requests: CloudJoinRequest[];
  loading: boolean;
  /** The service's own sentence for the last refusal, or a load failure. */
  error: string | null;
  /** What is in flight, so its button reads busy and the rest wait. */
  busy: string | null;
  drafts: Record<string, ApproveDraft>;
  renaming: { memberId: string; name: string } | null;
  removing: { memberId: string; typed: string } | null;
  /** The last thing that worked, said once. */
  notice: string | null;
}

export const IDLE_MEMBERS: MembersState = {
  list: null,
  requests: [],
  loading: true,
  error: null,
  busy: null,
  drafts: {},
  renaming: null,
  removing: null,
  notice: null,
};

export interface MembersActions {
  onDraft: (code: string, draft: ApproveDraft) => void;
  onApprove: (request: CloudJoinRequest) => void;
  onDeny: (request: CloudJoinRequest) => void;
  onRenameStart: (member: CloudMember) => void;
  onRenameDraft: (name: string) => void;
  onRenameSave: () => void;
  onRenameCancel: () => void;
  onRemoveAsk: (member: CloudMember) => void;
  onRemoveTyped: (typed: string) => void;
  onRemoveConfirm: () => void;
  onRemoveCancel: () => void;
  onRemoveDevice: (deviceId: string) => void;
  onReload: () => void;
}

/**
 * The default choice for a request: a new member for the owner, yourself for a member. A
 * request that came from a share link carries the name the link suggested, prefilled for the
 * owner to keep or change.
 */
export function defaultDraft(list: CloudMemberList, request?: Pick<CloudJoinRequest, "invitedAs">): ApproveDraft {
  const choices = approveChoices(list);
  const self = selfOf(list);
  return choices.canAdmitNew
    ? { mode: "new", name: request?.invitedAs?.trim() ?? "", memberId: self?.memberId ?? "" }
    : { mode: "existing", name: "", memberId: self?.memberId ?? "" };
}

/** Can this draft be approved as it stands? A new member needs a name. */
export function draftReady(draft: ApproveDraft): boolean {
  return draft.mode === "new" ? draft.name.trim().length > 0 : draft.memberId.length > 0;
}

function MemberChip({ name, removed }: { name: string; removed?: boolean }) {
  return (
    <span
      aria-hidden
      data-member-chip
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
        removed ? "bg-surface-sunken text-text-tertiary" : "bg-primary/15 text-primary",
      )}
    >
      {memberInitials(name)}
    </span>
  );
}

function RequestCard({
  request,
  list,
  draft,
  busy,
  now,
  actions,
  slug,
}: {
  request: CloudJoinRequest;
  list: CloudMemberList;
  draft: ApproveDraft;
  busy: string | null;
  now: number;
  actions: MembersActions;
  slug: string;
}) {
  const choices = approveChoices(list);
  const self = selfOf(list);
  const ownOnly = !choices.canAdmitNew;
  const id = `join-${request.code}`;
  return (
    <div data-join-request={request.code} className="space-y-3 rounded-lg border bg-surface-raised p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{request.label ?? "A device"}</span>
        <span className="text-caption text-text-tertiary">{relativeTime(request.createdAt, now)}</span>
      </div>
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-caption text-text-tertiary">Code</span>
          <span data-join-request-code className="font-mono text-lg font-semibold tracking-widest">
            {request.code}
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Check that this matches the code on their screen before you approve.
        </p>
      </div>

      <fieldset className="space-y-2" aria-label={`Who ${request.label ?? "this device"} belongs to`}>
        <label
          className={cn("flex flex-wrap items-center gap-2 text-[13px]", ownOnly && "text-text-tertiary")}
          data-approve-new
          data-disabled={ownOnly ? "" : undefined}
        >
          <input
            type="radio"
            name={`${id}-mode`}
            checked={draft.mode === "new"}
            disabled={ownOnly}
            onChange={() => actions.onDraft(request.code, { ...draft, mode: "new" })}
          />
          New member
          {ownOnly ? (
            <span className="text-caption">owner only</span>
          ) : (
            <Input
              aria-label="New member's name"
              placeholder="their name"
              value={draft.name}
              onChange={(event) => actions.onDraft(request.code, { ...draft, mode: "new", name: event.target.value })}
              className="h-control-sm w-44 max-md:w-full"
            />
          )}
        </label>
        {choices.existing.length > 0 ? (
          <label className="flex flex-wrap items-center gap-2 text-[13px]" data-approve-existing>
            <input
              type="radio"
              name={`${id}-mode`}
              checked={draft.mode === "existing"}
              onChange={() => actions.onDraft(request.code, { ...draft, mode: "existing" })}
            />
            {choices.existing.length === 1 ? (
              <span>
                {ownOnly ? "Add to:" : "Add to existing:"} {choices.existing[0]!.name}
                {choices.existing[0]!.memberId === self?.memberId ? " (you)" : ""}
              </span>
            ) : (
              <>
                <span>Add to existing:</span>
                <select
                  aria-label="Existing member"
                  value={draft.memberId}
                  onChange={(event) =>
                    actions.onDraft(request.code, { ...draft, mode: "existing", memberId: event.target.value })
                  }
                  className="h-control-sm rounded-md border bg-background px-2 text-[13px]"
                >
                  {choices.existing.map((member) => (
                    <option key={member.memberId} value={member.memberId}>
                      {member.name}
                      {member.memberId === self?.memberId ? " (you)" : ""}
                    </option>
                  ))}
                </select>
              </>
            )}
          </label>
        ) : null}
        {ownOnly && choices.ownerName ? (
          <p className="text-[12px] text-muted-foreground" data-owner-only-note>
            Only {choices.ownerName} can admit new people.
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => actions.onDeny(request)}
          data-deny={request.code}
        >
          {busy === `deny:${request.code}` ? "Denying…" : "Deny"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy !== null || !draftReady(draft)}
          onClick={() => actions.onApprove(request)}
          data-approve={request.code}
          data-approve-slug={slug}
        >
          {busy === `approve:${request.code}` ? "Approving…" : ownOnly ? "Approve as mine" : "Approve"}
        </Button>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  list,
  state,
  now,
  actions,
}: {
  member: CloudMember;
  list: CloudMemberList;
  state: MembersState;
  now: number;
  actions: MembersActions;
}) {
  const isSelf = member.memberId === list.self.memberId;
  const renaming = state.renaming?.memberId === member.memberId ? state.renaming : null;
  return (
    <li data-member={member.name} data-removed={member.removed ? "" : undefined} className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <MemberChip name={member.name} removed={member.removed} />
        {renaming ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              actions.onRenameSave();
            }}
          >
            <Input
              aria-label={`New name for ${member.name}`}
              value={renaming.name}
              onChange={(event) => actions.onRenameDraft(event.target.value)}
              className="h-control-sm w-40"
            />
            <Button type="submit" size="sm" disabled={state.busy !== null || renaming.name.trim().length === 0}>
              {state.busy === "rename" ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={actions.onRenameCancel}>
              Cancel
            </Button>
          </form>
        ) : (
          <span className={cn("text-[13px] font-medium", member.removed && "text-text-tertiary line-through")}>
            {member.name}
          </span>
        )}
        {member.isOwner ? <span className="rounded-full bg-surface-sunken px-2 py-px text-caption text-text-secondary">owner</span> : null}
        {isSelf ? <span className="text-caption text-text-tertiary">you</span> : null}
        {member.removed ? <span className="text-caption text-text-tertiary">removed</span> : null}
        <span className="ml-auto text-caption text-text-tertiary" data-member-summary>
          {member.removed ? "no access" : `${deviceCount(member)} · ${relativeTime(memberLastSeen(member), now)}`}
        </span>
      </div>
      <ul className="space-y-1 pl-9">
        {member.devices.map((device) => (
          <li
            key={device.deviceId}
            data-device={device.deviceId}
            className={cn("flex flex-wrap items-center gap-2 text-[12px]", device.revoked && "text-text-tertiary")}
          >
            <span className="min-w-0 truncate">{device.label ?? "unnamed device"}</span>
            <span className="text-text-tertiary">
              ·{" "}
              {device.deviceId === list.self.deviceId
                ? "this device"
                : device.revoked
                  ? "removed"
                  : relativeTime(device.lastSeenAt, now)}
            </span>
            {mayRemoveDevice(list, member, device.deviceId) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2 text-[12px]"
                disabled={state.busy !== null}
                onClick={() => actions.onRemoveDevice(device.deviceId)}
                data-remove-device={device.deviceId}
              >
                {state.busy === `device:${device.deviceId}` ? "Removing…" : "Remove"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {!renaming && (mayRename(list, member) || mayRemoveMember(list, member)) ? (
        <div className="flex flex-wrap gap-2 pl-9">
          {mayRename(list, member) ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => actions.onRenameStart(member)} data-rename={member.name}>
              Rename
            </Button>
          ) : null}
          {mayRemoveMember(list, member) ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px] text-[var(--status-task-icon-blocked)]"
              onClick={() => actions.onRemoveAsk(member)}
              data-remove-member={member.name}
            >
              Remove {member.name}…
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function MembersPanel({
  state,
  actions,
  slug,
  now = Date.now(),
}: {
  state: MembersState;
  actions: MembersActions;
  slug: string;
  now?: number;
}) {
  const { list } = state;
  if (list === null) {
    return (
      <div data-members-panel data-loading={state.loading ? "" : undefined} className="space-y-3">
        {state.loading ? (
          <p className="text-[13px] text-muted-foreground">Asking the sync service who is in {slug}…</p>
        ) : (
          <Section title="Members" error={state.error}>
            <p className="text-[13px] text-muted-foreground">
              This workspace is not connected to a sync service on this computer, so it has no members here. Connect it
              under Cloud sync, or join a shared workspace from the empty task list.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={actions.onReload}>
              Try again
            </Button>
          </Section>
        )}
      </div>
    );
  }

  const ordered = orderMembers(list);
  const current = ordered.filter((member) => !member.removed);
  const removing = state.removing ? list.members.find((member) => member.memberId === state.removing!.memberId) ?? null : null;

  return (
    <div data-members-panel className="space-y-6">
      {state.notice ? (
        <p role="status" data-members-notice className="rounded-md border px-3 py-2 text-[13px]">
          {state.notice}
        </p>
      ) : null}
      {/* Any member may invite: the link admits nobody until a member approves the code. */}
      <InviteBox slug={slug} />
      {state.requests.length > 0 ? (
        <Section title={state.requests.length === 1 ? "Pending request" : `Pending requests · ${state.requests.length}`}>
          <div className="space-y-3">
            {state.requests.map((request) => (
              <RequestCard
                key={request.code}
                request={request}
                list={list}
                draft={state.drafts[request.code] ?? defaultDraft(list, request)}
                busy={state.busy}
                now={now}
                actions={actions}
                slug={slug}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title={`Members · ${current.length}`}
        description="Each person, with their devices underneath and when each was last seen. The sync service is the authority; this list is what it said just now."
        error={state.error}
      >
        <ul className="divide-y">
          {ordered.map((member) => (
            <MemberRow key={member.memberId} member={member} list={list} state={state} now={now} actions={actions} />
          ))}
        </ul>
        {state.requests.length === 0 ? (
          <p className="text-[12px] text-muted-foreground" data-no-requests>
            No one is waiting to join. Someone joins with <code className="font-mono">staple cloud join</code> in their
            clone, or from the empty task list, and their request shows here.
          </p>
        ) : null}
      </Section>

      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name} from ${slug}?` : ""}
        description={
          removing
            ? `Their ${deviceCount(removing)} stop${removing.devices.filter((d) => !d.revoked).length === 1 ? "s" : ""} syncing on the next request. ` +
              "Their local copy stays on their machine. Tasks assigned to them keep the name until you reassign them."
            : ""
        }
        confirmLabel={state.busy === "remove" ? "Removing…" : "Remove"}
        destructive
        busy={state.busy !== null || removing === null || !removeConfirmMatches(state.removing?.typed ?? "", removing.name)}
        onConfirm={actions.onRemoveConfirm}
        onCancel={actions.onRemoveCancel}
      >
        {removing ? (
          <div className="mt-3 space-y-1.5">
            <label htmlFor="remove-member-confirm" className="text-[12px] text-muted-foreground">
              Type <span className="font-medium text-foreground">{removing.name}</span> to confirm
            </label>
            <Input
              id="remove-member-confirm"
              data-remove-confirm
              autoComplete="off"
              value={state.removing?.typed ?? ""}
              onChange={(event) => actions.onRemoveTyped(event.target.value)}
            />
            {state.error ? <InlineError>{state.error}</InlineError> : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** The controller: fetch on open, run each action, keep the panel's state. */
export function MembersSection({ ws }: { ws?: string }) {
  const slug = ws ?? "";
  const [state, setState] = useState<MembersState>(IDLE_MEMBERS);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((answer: CloudMembersResponse, patch: Partial<MembersState> = {}) => {
    if (!alive.current) return;
    setState((current) => ({
      ...current,
      list: answer.members ?? current.list,
      requests: answer.requests ?? current.requests,
      loading: false,
      error: null,
      busy: null,
      ...patch,
    }));
    if (answer.requests) setPendingJoinRequests(answer.requests.length);
  }, []);

  const fail = useCallback((error: unknown) => {
    if (!alive.current) return;
    setState((current) => ({
      ...current,
      loading: false,
      busy: null,
      error: error instanceof Error ? error.message : String(error),
    }));
  }, []);

  const load = useCallback(() => {
    if (!slug) return;
    setState((current) => ({ ...current, loading: current.list === null, error: null }));
    fetchMembers({ slug }).then((answer) => apply(answer), fail);
  }, [slug, apply, fail]);

  // Opening the section is a person's action: always ask the service.
  useEffect(() => {
    setState(IDLE_MEMBERS);
    load();
  }, [load]);

  const run = (busy: string, work: () => Promise<CloudMembersResponse>, patch: (answer: CloudMembersResponse) => Partial<MembersState>) => {
    setState((current) => ({ ...current, busy, error: null, notice: null }));
    work().then((answer) => apply(answer, patch(answer)), fail);
  };

  const actions: MembersActions = {
    onDraft: (code, draft) => setState((current) => ({ ...current, drafts: { ...current.drafts, [code]: draft } })),
    onApprove: (request) => {
      const draft = state.drafts[request.code] ?? (state.list ? defaultDraft(state.list, request) : null);
      if (!draft) return;
      run(
        `approve:${request.code}`,
        () =>
          approveJoinRequest(
            draft.mode === "new"
              ? { slug, code: request.code, newMember: draft.name.trim() }
              : { slug, code: request.code, memberId: draft.memberId },
          ),
        (answer) => {
          const approved = (answer as { approved?: { member: { name: string } | null; newMember: boolean } }).approved;
          return {
            notice: approved?.newMember
              ? `Approved ${request.code}: ${approved.member?.name ?? "they"} joined as a new member.`
              : `Approved ${request.code}: the device was added to ${approved?.member?.name ?? "the member"}.`,
          };
        },
      );
    },
    onDeny: (request) =>
      run(`deny:${request.code}`, () => denyJoinRequest({ slug, code: request.code }), () => ({
        notice: `Denied ${request.code}. Nothing is stored on that device.`,
      })),
    onRenameStart: (member) => setState((current) => ({ ...current, renaming: { memberId: member.memberId, name: member.name } })),
    onRenameDraft: (name) => setState((current) => (current.renaming ? { ...current, renaming: { ...current.renaming, name } } : current)),
    onRenameSave: () => {
      const renaming = state.renaming;
      if (!renaming) return;
      run("rename", () => renameMember({ slug, memberId: renaming.memberId, name: renaming.name.trim() }), () => ({
        renaming: null,
        notice: `Renamed to ${renaming.name.trim()}.`,
      }));
    },
    onRenameCancel: () => setState((current) => ({ ...current, renaming: null })),
    onRemoveAsk: (member) => setState((current) => ({ ...current, removing: { memberId: member.memberId, typed: "" }, error: null })),
    onRemoveTyped: (typed) => setState((current) => (current.removing ? { ...current, removing: { ...current.removing, typed } } : current)),
    onRemoveConfirm: () => {
      const removing = state.removing;
      if (!removing) return;
      run("remove", () => removeMember({ slug, memberId: removing.memberId, confirm: removing.typed }), (answer) => ({
        removing: null,
        notice: `Removed ${(answer as { removed?: { name: string } }).removed?.name ?? "the member"}. Their devices lose access on their next request.`,
      }));
    },
    onRemoveCancel: () => setState((current) => ({ ...current, removing: null, error: null })),
    onRemoveDevice: (deviceId) =>
      run(`device:${deviceId}`, () => revokeMemberDevice({ slug, deviceId }), () => ({
        notice: "Device removed. It loses access on its next request.",
      })),
    onReload: load,
  };

  return <MembersPanel state={state} actions={actions} slug={slug} />;
}
