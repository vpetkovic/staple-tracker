import type {ReactNode} from 'react';
import clsx from 'clsx';
import {useScenePlayback} from './useScenePlayback';
import {ScenePlayback} from './parts';
import styles from './Scene.module.css';

/** What a page may set on any scene. Every scene works with none of them. */
export type SceneOptions = {
  className?: string;
  /** `bottom` fades the last rows out so the fragment reads as a detail; `none` shows it whole. */
  fade?: 'bottom' | 'none';
  /** Drop the window bar, for a cell that already names the feature. */
  bar?: boolean;
  /** Keep replaying while in view. The scene then shows a pause control. */
  loop?: boolean;
};

type Props = SceneOptions & {
  /** The text alternative: one sentence saying what the scene shows. */
  label: string;
  /** The window bar: what this piece of UI is. */
  title?: ReactNode;
  /** Right side of the window bar. */
  meta?: ReactNode;
  /** When each step begins, in milliseconds. See `useScenePlayback`. */
  timeline: readonly number[];
  /** The scene's content for a step. Every step must occupy the same box. */
  children: (step: number) => ReactNode;
};

/**
 * The frame every scene sits in: a hairline panel with an optional window bar and an
 * optional faded edge. It is an image to assistive technology (`role="img"` with the
 * label; the drawn UI is hidden from the accessibility tree), it is a size container
 * (scenes adapt with `@container scene`, not with media queries), and it owns the
 * playback state that the scene's CSS reads.
 */
export default function Scene({label, title, meta, timeline, children, className, fade = 'none', bar = true, loop = false}: Props): ReactNode {
  const {ref, step, state, live, paused, togglePaused} = useScenePlayback(timeline, {loop});
  return (
    <div ref={ref} className={clsx(styles.frame, className)} data-scene-state={state} data-scene-step={step}>
      <div role="img" aria-label={label} className={styles.panel}>
        <div aria-hidden="true" className={styles.inner}>
          {bar && title && (
            <div className={styles.bar}>
              <span className={styles.title}>{title}</span>
              {meta && <span className={styles.meta}>{meta}</span>}
            </div>
          )}
          <div className={clsx(styles.body, fade === 'bottom' && styles.fadeBottom)}>
            <ScenePlayback.Provider value={state}>{children(step)}</ScenePlayback.Provider>
          </div>
        </div>
      </div>
      {/* A looping scene holds the control's place from the first paint, so nothing moves when it appears. */}
      {loop && !live && <span className={styles.pauseSpace} aria-hidden="true" />}
      {loop && live && (
        <button type="button" className={styles.pause} onClick={togglePaused} aria-label={paused ? 'Play animation' : 'Pause animation'}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {paused ? <path d="M5 3.5v9l7-4.5z" fill="currentColor" /> : <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor" />}
          </svg>
          <span>{paused ? 'Play' : 'Pause'}</span>
        </button>
      )}
    </div>
  );
}
