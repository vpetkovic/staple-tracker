/** The one choice the link dialog remembers, per browser: which kinds it last searched. */
export type KindFilter = "all" | "issue" | "pull_request";

const KEY = "staple:link-kind:v1";

export function loadKindFilter(): KindFilter {
  try {
    const value = localStorage.getItem(KEY);
    return value === "issue" || value === "pull_request" ? value : "all";
  } catch {
    return "all";
  }
}

export function saveKindFilter(kind: KindFilter): void {
  try {
    localStorage.setItem(KEY, kind);
  } catch {
    // Private windows and blocked storage: the dialog still works, it just forgets.
  }
}
