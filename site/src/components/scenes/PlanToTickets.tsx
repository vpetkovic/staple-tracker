import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Chip, List, Reveal, Row} from './parts';
import styles from './PlanToTickets.module.css';

// The plan from the landing page: each step becomes a ticket under the epic, and
// "after 1" becomes a dependency.
const LINES: {text: string; id: string; heading?: boolean}[] = [
  {text: '# Multi-tenancy', id: 'APP-1', heading: true},
  {text: '1. Tenant id on every table', id: 'APP-2'},
  {text: '2. Scope queries by tenant (after 1)', id: 'APP-3'},
  {text: '3. Tenant-aware billing (after 2)', id: 'APP-4'},
];

/** A Markdown plan turns into an epic with tickets and the dependencies between them. */
export default function PlanToTickets(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="A Markdown plan, plan.md, becomes the epic APP-1 Multi-tenancy with three tickets. APP-3 waits on APP-2 and APP-4 waits on APP-3."
      title="plan.md → staple"
      meta="APP-1"
      timeline={[300, 850, 1400, 1950, 2700, 3400]}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.file}>
            <div className={styles.fileName}>
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M4 1.75h5.25L12.5 5v9.25h-8.5z M9 1.75V5.25h3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
              </svg>
              plan.md
            </div>
            {LINES.map((line, i) => (
              <div key={line.id} className={clsx(styles.line, line.heading && styles.heading, step === i + 1 && styles.lineLit)}>
                <span className={styles.lineText}>{line.text}</span>
                <Reveal on={step >= i + 1} from="left" inline className={styles.lineId}>
                  {line.id}
                </Reveal>
              </div>
            ))}
          </div>

          <div className={styles.tickets}>
            <List>
              <Row id="APP-1" status="backlog" title="Multi-tenancy" epic shown={step >= 1} trail={<Chip>Epic</Chip>} />
              <Row id="APP-2" status={step >= 6 ? 'ready' : 'backlog'} title="Tenant id on every table" child shown={step >= 2} lit={step >= 6} className={styles.edge} />
              <Row id="APP-3" status="backlog" title="Scope queries by tenant" child shown={step >= 3} dim={step >= 5} className={styles.edge} />
              <Row id="APP-4" status="backlog" title="Tenant-aware billing" child shown={step >= 4} dim={step >= 5} className={styles.edge} />
            </List>
            {/* The dependency arrows: each points from a ticket up to the one it waits on. */}
            <svg className={clsx(styles.arrows, step >= 5 && styles.arrowsOn)} viewBox="0 0 24 148" width="24" height="148">
              <path className={styles.arrow} pathLength="1" d="M3 89 C 17 89 17 59 5 59" />
              <path className={styles.head} d="M9 55.5 L5 59 L9 62.5" />
              <path className={clsx(styles.arrow, styles.second)} pathLength="1" d="M3 126 C 17 126 17 96 5 96" />
              <path className={clsx(styles.head, styles.second)} d="M9 92.5 L5 96 L9 99.5" />
            </svg>
          </div>
        </div>
      )}
    </Scene>
  );
}
