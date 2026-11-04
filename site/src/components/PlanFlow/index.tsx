import type {ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Step = {
  /** The step's heading. */
  title: ReactNode;
  /** One or two sentences under the heading. */
  text: ReactNode;
  /** The picture of the step: a `FlowFile`, `FlowTickets` or `FlowEvents`. */
  visual: ReactNode;
};

type Props = {
  steps: Step[];
  /** Names the list for assistive technology, e.g. "From a plan to finished work". */
  label: string;
  className?: string;
};

// A numbered flow of steps that read left to right from 997 px up and top to bottom
// below, with a connector between each pair. Built from text, not an image, so it
// switches with the theme and stays legible at every width.
export default function PlanFlow({steps, label, className}: Props): ReactNode {
  return (
    <ol className={clsx(styles.flow, className)} aria-label={label}>
      {steps.map((step, i) => (
        <li key={i} className={styles.step}>
          {i > 0 && (
            <span className={styles.connector} aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16">
                <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
          <div className={styles.head}>
            <span className={styles.number} aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 className={styles.title}>{step.title}</h3>
            <p className={styles.text}>{step.text}</p>
          </div>
          <div className={styles.visual}>{step.visual}</div>
        </li>
      ))}
    </ol>
  );
}

function Panel({title, meta, children}: {title: ReactNode; meta?: ReactNode; children: ReactNode}): ReactNode {
  return (
    <div className={styles.panel}>
      <div className={styles.panelBar}>
        <span className={styles.panelTitle}>{title}</span>
        {meta && <span className={styles.panelMeta}>{meta}</span>}
      </div>
      <div className={styles.panelBody}>{children}</div>
    </div>
  );
}

// A Markdown file: the name in the bar, the lines in mono. A line starting with `#` is a heading.
export function FlowFile({name, meta, lines}: {name: string; meta?: ReactNode; lines: string[]}): ReactNode {
  return (
    <Panel title={name} meta={meta}>
      <div className={styles.file}>
        {lines.map((line, i) => (
          <span key={i} className={clsx(styles.fileLine, line.startsWith('#') && styles.fileHeading)}>
            {line || ' '}
          </span>
        ))}
      </div>
    </Panel>
  );
}

export type FlowTicket = {
  id: string;
  title: string;
  /** done, being worked on, ready to take, or waiting on another ticket. */
  state: 'done' | 'active' | 'ready' | 'waiting';
  /** An epic heads the tree; its tickets sit indented under it. */
  epic?: boolean;
  /** A short tag after the title: who holds it, or what it waits on. */
  note?: ReactNode;
  /** Marks a ticket filed after the plan was broken down. */
  added?: boolean;
};

const STATE_LABEL: Record<FlowTicket['state'], string> = {
  done: 'Done',
  active: 'In progress',
  ready: 'Ready',
  waiting: 'Waiting',
};

// An epic and its tickets, each with a status mark (named for screen readers) and an optional tag.
export function FlowTickets({title, meta, tickets}: {title: string; meta?: ReactNode; tickets: FlowTicket[]}): ReactNode {
  return (
    <Panel title={title} meta={meta}>
      <ul className={styles.tickets}>
        {tickets.map((t) => (
          <li key={t.id} className={clsx(styles.ticket, t.epic && styles.epic, t.added && styles.added)}>
            <span className={clsx(styles.mark, styles[t.state])} aria-hidden="true" />
            <span className={styles.srOnly}>{STATE_LABEL[t.state]}: </span>
            <span className={styles.ticketId}>{t.id}</span>
            <span className={styles.ticketTitle}>{t.title}</span>
            {t.note && <span className={styles.note}>{t.note}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export type FlowEvent = {
  /** Who acted, in mono: an agent's name, or a person. */
  who?: string;
  text: ReactNode;
  /** `warn` for an interruption, `accent` for the outcome. */
  tone?: 'default' | 'warn' | 'accent';
};

// A ticket's history as a short timeline: a rail with one dot per event.
export function FlowEvents({title, meta, events}: {title: string; meta?: ReactNode; events: FlowEvent[]}): ReactNode {
  return (
    <Panel title={title} meta={meta}>
      <ol className={styles.events}>
        {events.map((e, i) => (
          <li key={i} className={clsx(styles.event, e.tone && e.tone !== 'default' && styles[e.tone])}>
            {e.who && <span className={styles.who}>{e.who}</span>}
            <span className={styles.eventText}>{e.text}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
