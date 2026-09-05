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

/**
 * Is ANY floating surface open — a dialog, or a menu, a select's list or a popover? The
 * rail's shortcuts ask this rather than `dialogIsOpen`: `[` while the workspace
 * switcher's menu is up would collapse the rail out from under it, and Escape while a
 * select is open belongs to the select.
 *
 * Keyed on the vendored primitives' own `data-slot`s and on `role="menu"`, NOT on
 * `role="listbox"`: the task list is a listbox at rest (components/task-list), so that
 * role would say "open" on every visit to Tasks. Radix mounts these contents only while
 * open, so presence is the state.
 */
export function floatingSurfaceIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return (
    dialogIsOpen() ||
    document.querySelector(
      "[role='menu'], [data-slot='dropdown-menu-content'], [data-slot='select-content'], [data-slot='popover-content']",
    ) !== null
  );
}
