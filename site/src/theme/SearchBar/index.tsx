import {useEffect, type ComponentProps, type ReactNode} from 'react';
import OriginalSearchBar from '@theme-original/SearchBar';

// The search plugin's bar, unchanged, except that it no longer takes focus back.
//
// Focusing the input starts loading the search index and sets a flag that focuses the
// input again once the index has loaded; leaving the input does not clear the flag. A
// keyboard user who tabs through the search box is pulled back into it about a second
// later, on every page. The plugin offers no option for this, so the input's `focus()`
// is guarded. A call is let through while the input has focus, while a key, pointer or
// click event is being handled (the search shortcut, a click on the bar), and while the
// reader has not left the input: loading the index moves the input into a new wrapper,
// which blurs it without anyone leaving, and the plugin focuses it again. The reader
// leaves it by moving focus to something else, or by a key or pointer; after that, the
// call the index load makes, from a network callback, is dropped.

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
  let inside = false;
  input.addEventListener('focus', () => {
    inside = true;
  });
  input.addEventListener('blur', (event) => {
    if (event.relatedTarget || handling > 0) inside = false;
  });
  input.focus = (options?: FocusOptions) => {
    if (inside || handling > 0 || document.activeElement === input) focus(options);
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
