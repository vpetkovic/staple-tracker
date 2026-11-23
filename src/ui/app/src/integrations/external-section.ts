export type ExternalSection = "all" | "issue" | "pull_request";
const EVENT = "staple:external-section";
let pending: ExternalSection | null = null;
export function requestExternalSection(section: ExternalSection): void {
  pending = section;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: section }));
}
export function takeExternalSection(): ExternalSection | null {
  const section = pending;
  pending = null;
  return section;
}
export function onExternalSection(handler: (section: ExternalSection) => void): () => void {
  const listener = () => {
    const section = takeExternalSection();
    if (section) handler(section);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
