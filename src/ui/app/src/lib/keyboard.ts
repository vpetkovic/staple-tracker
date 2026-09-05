/**
 * The one question every bare-letter shortcut has to ask first: is the user typing?
 *
 * The palette binds cmd-K and can afford to ignore focus; `c` (new task) and `[` (toggle
 * the rail) cannot. Without this they would fire out of the search box, the comment
 * editor and the dialog's own title field, which is how a shortcut becomes hostile.
 * Shared so that two mounts cannot disagree about what counts as typing.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Is a modal surface open? Radix marks the rest of the page inert while any dialog is
 * up, so a shortcut that opened a second one would trap focus between the two.
 */
export function dialogIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector("[data-slot='dialog-content'], [role='dialog']") !== null;
}
