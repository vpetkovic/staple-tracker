import {createContext, useContext, useRef, type CSSProperties, type ReactNode} from 'react';
import clsx from 'clsx';
import type {PlaybackState} from './useScenePlayback';
import styles from './parts.module.css';

// What staple's web UI is made of, redrawn for the scenes: the status glyph, the
// priority bars, a ticket row, an agent's avatar, a chip, a meter. Everything reads
// the tokens, so both themes work, and everything keeps its box whatever its state.

/** Set by `Scene`, so a part can tell a change that happens on stage from a rewind. */
export const ScenePlayback = createContext<PlaybackState>('done');

/** The status categories of the web UI, as its 16 px glyphs draw them. */
export type Status = 'backlog' | 'ready' | 'active' | 'review' | 'done' | 'blocked' | 'gated';

function GlyphShape({status}: {status: Status}): ReactNode {
  switch (status) {
    case 'backlog':
      return <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2.31" />;
    case 'ready':
      return <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />;
    case 'active':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 8 L8 4 A4 4 0 0 1 8 12 Z" fill="currentColor" />
        </>
      );
    case 'review':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 8 L8 4 A4 4 0 1 1 4 8 Z" fill="currentColor" />
        </>
      );
    case 'done':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.8 8.2 L6.9 10.3 L11.2 5.8" fill="none" className={styles.cut} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'blocked':
      return (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.9 8h6.2" fill="none" className={styles.cut} strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case 'gated':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.9 4.9h4.2L5.9 11.1h4.2z" fill="currentColor" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
        </>
      );
  }
}

/** A status as the web UI draws it: a ring that fills up, with `blocked` and `gated` breaking the sequence. */
export function StatusGlyph({status, className}: {status: Status; className?: string}): ReactNode {
  const playback = useContext(ScenePlayback);
  // A change while the scene plays pops once; a rewind, or the first paint, does not.
  const seen = useRef({status, pops: 0});
  if (seen.current.status !== status) {
    seen.current = {status, pops: playback === 'playing' ? seen.current.pops + 1 : 0};
  }
  const pops = seen.current.pops;
  return (
    <svg key={pops} className={clsx(styles.glyph, styles[`status_${status}`], pops > 0 && styles.pop, className)} viewBox="0 0 16 16" width="16" height="16">
      <GlyphShape status={status} />
    </svg>
  );
}

/** The three priority bars: `level` of them are solid. */
export function Priority({level = 2}: {level?: 1 | 2 | 3}): ReactNode {
  return (
    <svg className={styles.priority} viewBox="0 0 14 12" width="14" height="12">
      {[0, 1, 2].map((i) => (
        <rect key={i} x={i * 5} y={8 - i * 3} width="3" height={4 + i * 3} rx="1" className={i < level ? styles.priorityOn : styles.priorityOff} />
      ))}
    </svg>
  );
}

/** An agent or a person: the two-letter square the web UI uses. */
export function Agent({name, className}: {name: string; className?: string}): ReactNode {
  return <span className={clsx(styles.agent, className)}>{name.slice(0, 2).toUpperCase()}</span>;
}

type Tone = 'neutral' | 'accent' | 'info' | 'warn' | 'danger' | 'planned';

/** A small pill: a count, a verdict, a badge. */
export function Chip({children, tone = 'neutral', className}: {children: ReactNode; tone?: Tone; className?: string}): ReactNode {
  return <span className={clsx(styles.chip, styles[`chip_${tone}`], className)}>{children}</span>;
}

type RowProps = {
  id?: ReactNode;
  status: Status;
  title: ReactNode;
  priority?: 1 | 2 | 3;
  /** Chips, an avatar, a date: what sits at the right end of the row. */
  trail?: ReactNode;
  /** One level under an epic. */
  child?: boolean;
  /** An epic: its title is set stronger. */
  epic?: boolean;
  /** Waiting on something: drawn back. */
  dim?: boolean;
  /** The row the scene is about right now. */
  lit?: boolean;
  /** Before the identifier: a rank in the pickup order. */
  lead?: ReactNode;
  /** `false` keeps the row's place but hides it, until it arrives. */
  shown?: boolean;
  className?: string;
};

/** A ticket as a row of the Tasks view: priority, identifier, status, title, then cues. */
export function Row({id, status, title, priority, trail, child, epic, dim, lit, lead, shown = true, className}: RowProps): ReactNode {
  return (
    <div className={clsx(styles.row, child && styles.rowChild, epic && styles.rowEpic, dim && styles.rowDim, lit && styles.rowLit, !shown && styles.rowHidden, className)}>
      {lead !== undefined && <span className={styles.rowLead}>{lead}</span>}
      {priority && <Priority level={priority} />}
      {id && <span className={styles.rowId}>{id}</span>}
      <StatusGlyph status={status} />
      <span className={styles.rowTitle}>{title}</span>
      {trail && <span className={styles.rowTrail}>{trail}</span>}
    </div>
  );
}

/** The card a group of rows sits in. */
export function List({children, className}: {children: ReactNode; className?: string}): ReactNode {
  return <div className={clsx(styles.list, className)}>{children}</div>;
}

/** A small label above a part of a scene. */
export function Label({children, className}: {children: ReactNode; className?: string}): ReactNode {
  return <div className={clsx(styles.label, className)}>{children}</div>;
}

/**
 * Something that arrives: it holds its place from the start and fades and rises in
 * when `on` turns true. `from="none"` only fades.
 */
export function Reveal({on, children, className, from = 'below', inline}: {on: boolean; children: ReactNode; className?: string; from?: 'below' | 'left' | 'none'; inline?: boolean}): ReactNode {
  const Tag = inline ? 'span' : 'div';
  return <Tag className={clsx(styles.reveal, styles[`from_${from}`], inline && styles.revealInline, on && styles.on, className)}>{children}</Tag>;
}

/**
 * Two things in the same place, one replacing the other: both are laid out on top of
 * each other, so the box is as large as the larger one and nothing moves when they swap.
 */
export function Swap({on, before, after, className, align = 'start', block}: {on: boolean; before: ReactNode; after: ReactNode; className?: string; align?: 'start' | 'end'; block?: boolean}): ReactNode {
  return (
    <span className={clsx(styles.swap, align === 'end' && styles.swapEnd, block && styles.swapBlock, on && styles.on, className)}>
      <span className={styles.swapBefore}>{before}</span>
      <span className={styles.swapAfter}>{after}</span>
    </span>
  );
}

/** A track and its fill. `value` is 0 to 1; the fill grows when `on` turns true. */
export function Meter({value, on = true, tone = 'accent', className}: {value: number; on?: boolean; tone?: 'accent' | 'info' | 'warn' | 'neutral'; className?: string}): ReactNode {
  return (
    <span className={clsx(styles.meter, className)}>
      <span className={clsx(styles.meterFill, styles[`meter_${tone}`])} style={{transform: `scaleX(${on ? value : 0})`}} />
    </span>
  );
}

/** The mouse pointer, for the one moment a person acts. Position it from the scene's CSS. */
export function Pointer({className}: {className?: string}): ReactNode {
  return (
    <svg className={clsx(styles.pointer, className)} viewBox="0 0 20 20" width="20" height="20">
      <path d="M4 2.5 15.5 9.6l-5.1 1.2-2.6 4.8z" className={styles.pointerShape} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** A line that is typed out: it holds its full width and is uncovered a character at a time. */
export function Typed({on, children, className}: {on: boolean; children: string; className?: string}): ReactNode {
  return (
    <span className={clsx(styles.typed, on && styles.on, className)} style={{'--typed-chars': children.length} as CSSProperties}>
      {children}
    </span>
  );
}

/** Words a narrow cell can do without: shown from 24.5rem of scene width up. */
export function Wide({children}: {children: ReactNode}): ReactNode {
  return <span className={styles.wide}>{children}</span>;
}
