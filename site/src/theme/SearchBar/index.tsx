import {useEffect, type ComponentProps, type ReactNode} from 'react';
import OriginalSearchBar from '@theme-original/SearchBar';

// The search plugin's bar, unchanged, except that it no longer takes focus back.
//
// Focusing the input starts loading the search index and sets a flag that focuses the
// input again once the index has loaded; leaving the input does not clear the flag. A
// keyboard user who tabs through the search box is pulled back into it about a second
// later, on every page. The plugin offers no option for this, so the input's `focus()`
// is guarded: a call is let through while the input already has focus, or while a key,
// pointer or click event is being handled (the search shortcut, a click on the bar).
// The call the index load makes, from a network callback after the reader has moved
// on, is dropped.

const USER_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'touchstart', 'click'] as const;
const guarded = new WeakSet<HTMLInputElement>();
let handling = 0;

function track(): () => void {
  const start = (): void => {
    handling += 1;
    // Cleared in the next task, once every handler of this event has run (a microtask
    // would run between two listeners, before the plugin's own).
    setTimeout(() => {
      handling -= 1;
    }, 0);
  };
  for (const type of USER_EVENTS) document.addEventListener(type, start, true);
  return () => {
    for (const type of USER_EVENTS) document.removeEventListener(type, start, true);
  };
}

function guard(input: HTMLInputElement): void {
  if (guarded.has(input)) return;
  guarded.add(input);
  const focus = input.focus.bind(input);
  input.focus = (options?: FocusOptions) => {
    if (handling > 0 || document.activeElement === input) focus(options);
  };
}

export default function SearchBar(props: ComponentProps<typeof OriginalSearchBar>): ReactNode {
  useEffect(() => {
    const untrack = track();
    document.querySelectorAll<HTMLInputElement>('input.navbar__search-input').forEach(guard);
    return untrack;
  }, []);
  return <OriginalSearchBar {...props} />;
}
