import {useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject} from 'react';
import clsx from 'clsx';
import {StatusGlyph, type Status} from '@site/src/components/scenes';
import styles from './TicketChips.module.css';

// The ticket chips that drift through a hero, the state that says whether they may
// move, and the control that holds them. Decoration: the layer is hidden from
// assistive technology.

type Drift = 'early' | 'middle' | 'late';

/** Where the centre of a chip is: across and down the hero, as CSS lengths. */
export type Place = [string, string];

export type ChipSpec = {
  id: string;
  title: string;
  status: Status;
  /** 1 is nearest: full size and sharp. 3 is furthest: small, faint and soft. */
  depth: 1 | 2 | 3;
  /** Where it sits from 1280 px. Below that it takes `tablet`, and under 700 px
      `phone`. A chip without a place for a width is left out there. */
  at: Place;
  tablet?: Place;
  phone?: Place;
  /** How far it drifts in one cycle, in pixels, and how long a cycle takes. */
  drift: [number, number];
  seconds: number;
  /** When in its cycle it fades out and comes back. */
  leaves: Drift;
};

/** A place measured from the lower edge of the hero. */
export const fromBottom = (rem: number): string => `calc(100% - ${rem}rem)`;

// `off`: nothing moves (the server's HTML, no JavaScript, reduced motion).
// `on`: the chips drift. `held`: stopped where they are.
export type Motion = 'off' | 'on' | 'held';

export type DriftState = {
  /** Put this on the hero: out of view, it holds still. */
  ref: RefObject<HTMLElement | null>;
  /** True once the page runs in a browser that did not ask for reduced motion. */
  allowed: boolean;
  motion: Motion;
  paused: boolean;
  togglePaused: () => void;
};

/** Whether a hero's continuous motion runs: allowed, in view and not paused. */
export function useDrift(): DriftState {
  const ref = useRef<HTMLElement | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [inView, setInView] = useState(true);
  const [paused, setPaused] = useState(false);

  // Motion is allowed once the page runs in a browser that did not ask for less of it.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAllowed(!query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // Out of view, the hero holds still.
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => entry && setInView(entry.isIntersecting), {threshold: 0});
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const motion: Motion = !allowed ? 'off' : paused || !inView ? 'held' : 'on';
  return {ref, allowed, motion, paused, togglePaused: () => setPaused((value) => !value)};
}

/** The chips, each at its place. They drift only while `motion` is `on`. */
export default function TicketChips({chips, motion}: {chips: ChipSpec[]; motion: Motion}): ReactNode {
  return (
    <div className={styles.chips} data-motion={motion} aria-hidden="true">
      {chips.map((chip) => {
        const place = {'--x': chip.at[0], '--y': chip.at[1], '--tx': chip.tablet?.[0], '--ty': chip.tablet?.[1], '--px': chip.phone?.[0], '--py': chip.phone?.[1]} as CSSProperties;
        const drift = {'--dx': `${chip.drift[0]}px`, '--dy': `${chip.drift[1]}px`, '--cycle': `${chip.seconds}s`} as CSSProperties;
        return (
          <span key={chip.id} className={clsx(styles.slot, styles[`depth${chip.depth}`], !chip.tablet && styles.noTablet, !chip.phone && styles.noPhone)} style={place}>
            <span className={clsx(styles.chip, styles[`leaves_${chip.leaves}`])} style={drift}>
              <StatusGlyph status={chip.status} className={styles.chipGlyph} />
              <span className={styles.chipId}>{chip.id}</span>
              <span className={styles.chipTitle}>{chip.title}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** The control for everything in a hero that keeps moving. The page places it. */
export function PauseButton({paused, onToggle, className}: {paused: boolean; onToggle: () => void; className?: string}): ReactNode {
  return (
    <button type="button" className={clsx(styles.pause, className)} onClick={onToggle} aria-label={paused ? 'Play animation' : 'Pause animation'}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {paused ? <path d="M5 3.5v9l7-4.5z" fill="currentColor" /> : <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor" />}
      </svg>
      <span>{paused ? 'Play' : 'Pause'}</span>
    </button>
  );
}
