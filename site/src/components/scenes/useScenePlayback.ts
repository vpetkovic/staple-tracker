import {useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';

// `idle`: rewound to step 0 and waiting to be seen (nothing transitions).
// `playing`: the story is running. `done`: resting on the last step.
export type PlaybackState = 'idle' | 'playing' | 'done';

export type Playback = {
  /** Put this on the element whose visibility starts the scene. */
  ref: RefObject<HTMLDivElement | null>;
  /** 0 before anything has happened, up to `timeline.length` for the final state. */
  step: number;
  state: PlaybackState;
  /** True when the visitor asked for reduced motion: the scene shows its final state. */
  reduced: boolean;
  /** Only meaningful with `loop`: stops and restarts the repetition. */
  paused: boolean;
  togglePaused: () => void;
};

type Options = {
  /** Play again after a rest, for as long as the scene is in view. Needs a pause control. */
  loop?: boolean;
};

// How much of the scene has to be in view before it starts.
const START_RATIO = 0.35;
// The gap between rewinding and starting, so the rewind is painted without transitions.
const ARM_MS = 60;
// How long the last step takes to settle before the scene counts as resting.
const SETTLE_MS = 900;
// How long a looping scene rests on its final state before it plays again.
const REST_MS = 2600;

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The motion primitive every scene uses. `timeline` lists when each step begins, in
 * milliseconds from the start: `[400, 1200, 2000]` is a scene with a start state and
 * three steps. The scene starts when it scrolls into view, plays once and rests on its
 * final step; it rewinds when it has left the view completely, so it plays again on
 * re-entry.
 *
 * The final step is also what the server renders, what a browser without
 * IntersectionObserver shows, and what `prefers-reduced-motion: reduce` gets: with
 * reduced motion no timer is ever set.
 */
export function useScenePlayback(timeline: readonly number[], {loop = false}: Options = {}): Playback {
  const last = timeline.length;
  const ref = useRef<HTMLDivElement | null>(null);
  const [step, setStep] = useState(last);
  const [state, setState] = useState<PlaybackState>('done');
  const [reduced, setReduced] = useState(false);
  const [paused, setPaused] = useState(false);
  // The timeline is a literal in every scene; keying on its values keeps the effect stable.
  const timelineKey = timeline.join(',');

  useIsomorphicLayoutEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    const times = timelineKey === '' ? [] : timelineKey.split(',').map(Number);
    const finalStep = times.length;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!node || still || typeof IntersectionObserver === 'undefined') {
      setStep(finalStep);
      setState('done');
      return undefined;
    }

    let timers: number[] = [];
    let inView = false;
    const clear = () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers = [];
    };
    const rewind = () => {
      clear();
      setState('idle');
      setStep(0);
    };
    const play = () => {
      rewind();
      timers.push(window.setTimeout(() => setState('playing'), ARM_MS));
      times.forEach((at, i) => {
        timers.push(window.setTimeout(() => setStep(i + 1), ARM_MS + at));
      });
      const end = ARM_MS + (times[finalStep - 1] ?? 0) + SETTLE_MS;
      timers.push(
        window.setTimeout(() => {
          setState('done');
          if (loop) timers.push(window.setTimeout(play, REST_MS));
        }, end),
      );
    };

    if (paused) {
      // Paused scenes rest on the final state, like a scene that has finished.
      setStep(finalStep);
      setState('done');
      return undefined;
    }

    rewind();
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // Enough of it is showing: the usual share, or, for a scene a cell crops or one
        // taller than the screen, half the height of the viewport.
        const fills = entry.rootBounds ? entry.intersectionRect.height >= entry.rootBounds.height / 2 : false;
        if (entry.isIntersecting && (entry.intersectionRatio >= START_RATIO || fills)) {
          if (!inView) {
            inView = true;
            play();
          }
        } else if (!entry.isIntersecting && inView) {
          inView = false;
          rewind();
        }
      },
      {threshold: [0, 0.1, 0.2, START_RATIO, 0.5, 0.75]},
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [timelineKey, loop, paused, reduced]);

  const togglePaused = useCallback(() => setPaused((value) => !value), []);

  return {ref, step, state, reduced, paused, togglePaused};
}
