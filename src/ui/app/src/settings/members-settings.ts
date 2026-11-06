/**
 * SETTINGS → MEMBERS, the pure half (STA-441).
 *
 * Everything the Members panel, the approval toast and the join flow decide without a DOM:
 * which approval choices a person gets, how a time reads, whether the toast may poll, and
 * whether a typed confirmation matches. Pinned by `members-panel.test.tsx`, which renders to
 * a string like every other settings test.
 *
 * The service enforces every rule here: who may admit a new person, add a device to whom,
 * rename or remove. This file only decides what to OFFER, so a member is not shown a button
 * the service would refuse.
 */
import type { SettingCategoryView } from "@/lib/settings";
import type { CloudMember, CloudMemberList, CloudSurfaceReport } from "@/lib/types";

/**
 * The per-workspace category. Synthetic, like Cloud sync: members live on the sync service
 * and in a machine-local cache, never in the workspace database, so there is no registry
 * entry for it.
 */
export const MEMBERS_CATEGORY: SettingCategoryView = {
  id: "members",
  label: "Members",
  description:
    "The people who share this workspace through the sync service, their devices, and requests to join. " +
    "Opening this section asks the service for the current list.",
  scope: "workspace",
  editor: "fields",
  order: 42,
};

export function isMembersCategory(id: string | null | undefined): boolean {
  return id === MEMBERS_CATEGORY.id;
}

/** How often the toast asks for pending requests, and only with auto sync on and the tab visible. */
export const JOIN_REQUEST_POLL_MS = 20_000;

/**
 * May the page ask the service for pending join requests on its own?
 *
 * Only when this device already agreed to background traffic for this workspace (automatic
 * sync is on) and the tab is visible. Manual mode means nothing leaves the machine unless a
 * person asks, and a toast is not a person asking. Opening Settings → Members is, which is
 * why that fetch is not gated here.
 */
export function mayPollJoinRequests(report: Pick<CloudSurfaceReport, "auto" | "mode"> | null, visible: boolean): boolean {
  return report !== null && report.mode === "automatic" && report.auto === true && visible;
}

/** The member this machine is. Null when the list does not name it (a stale cache). */
export function selfOf(list: CloudMemberList): CloudMember | null {
  return list.members.find((member) => member.memberId === list.self.memberId) ?? null;
}

export function ownerOf(list: CloudMemberList): CloudMember | null {
  return list.members.find((member) => member.isOwner && !member.removed) ?? null;
}

/** People first by role (owner, then you, then the rest by name), removed members last. */
export function orderMembers(list: CloudMemberList): CloudMember[] {
  const rank = (member: CloudMember) =>
    member.removed ? 3 : member.isOwner ? 0 : member.memberId === list.self.memberId ? 1 : 2;
  return [...list.members].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** What the approve card may offer this person. The service checks the same rules again. */
export interface ApproveChoices {
  /** Owner only. A member sees the option disabled, with the owner's name. */
  canAdmitNew: boolean;
  /** Members a device may be added to: everyone current for the owner, only yourself otherwise. */
  existing: CloudMember[];
  /** Whose approval admits a new person, for the disabled option's sentence. */
  ownerName: string | null;
}

export function approveChoices(list: CloudMemberList): ApproveChoices {
  const self = selfOf(list);
  const owner = ownerOf(list);
  const canAdmitNew = self?.isOwner === true;
  const current = orderMembers(list).filter((member) => !member.removed);
  return {
    canAdmitNew,
    existing: canAdmitNew ? current : current.filter((member) => member.memberId === self?.memberId),
    ownerName: owner?.name ?? null,
  };
}

/** May this person rename `member`? Yourself always; anyone when you are the owner. */
export function mayRename(list: CloudMemberList, member: CloudMember): boolean {
  if (member.removed) return false;
  const self = selfOf(list);
  return self !== null && (self.isOwner || self.memberId === member.memberId);
}

/** May this person remove `member`? The owner, anyone but themselves. */
export function mayRemoveMember(list: CloudMemberList, member: CloudMember): boolean {
  const self = selfOf(list);
  return self?.isOwner === true && !member.removed && member.memberId !== self.memberId;
}

/**
 * May this person remove one device? Their own devices except the one they are using, and
 * the owner any device except their own current one. Revoking the device you are using is
 * `staple cloud devices revoke` at a terminal, deliberately: it would end this page's access.
 */
export function mayRemoveDevice(list: CloudMemberList, member: CloudMember, deviceId: string): boolean {
  const self = selfOf(list);
  if (self === null || member.removed || deviceId === list.self.deviceId) return false;
  const device = member.devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device || device.revoked) return false;
  return self.isOwner || self.memberId === member.memberId;
}

/** The typed confirmation for removing a member: their name, ignoring case and outer spaces. */
export function removeConfirmMatches(typed: string, name: string): boolean {
  return typed.trim().toLowerCase() === name.trim().toLowerCase() && typed.trim().length > 0;
}

/** Up to two letters for a member chip: initials of the first two words, else the first two letters. */
export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

/** "just now", "40s ago", "5m ago", "2h ago", "3d ago". Null reads "never". */
export function relativeTime(at: number | null, now: number): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The newest last-seen across a member's devices, for the row's summary. */
export function memberLastSeen(member: CloudMember): number | null {
  const seen = member.devices.map((device) => device.lastSeenAt).filter((at): at is number => at !== null);
  return seen.length === 0 ? null : Math.max(...seen);
}

/** "1 device" / "2 devices", counting devices still active. */
export function deviceCount(member: CloudMember): string {
  const active = member.devices.filter((device) => !device.revoked).length;
  return `${active} ${active === 1 ? "device" : "devices"}`;
}

/** "9:12" until `expiresAt`; "0:00" once past. */
export function countdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** How long the join window waits between polls: two seconds, growing to ten. Same as the CLI. */
export function joinPollDelay(attempt: number): number {
  return Math.min(Math.round(2000 * 1.5 ** attempt), 10_000);
}

/** The service's host, short, for a sentence ("…on staple-tracker-sync."). */
export function serviceName(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.split(".")[0] ?? endpoint;
  } catch {
    return endpoint;
  }
}
