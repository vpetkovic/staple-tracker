import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Agent, Chip, Label, StatusGlyph, Swap} from './parts';
import styles from './TicketContext.module.css';

const CRITERIA = ['Every table has a tenant_id column', 'Existing rows are backfilled', 'Queries still pass without a tenant'];

function Check({on}: {on: boolean}): ReactNode {
  return (
    <svg className={clsx(styles.check, on && styles.checkOn)} viewBox="0 0 16 16" width="16" height="16">
      <rect className={styles.checkBox} x="1.75" y="1.75" width="12.5" height="12.5" rx="3.5" />
      <path className={styles.checkMark} pathLength="1" d="M4.8 8.3 7 10.5l4.3-4.7" />
    </svg>
  );
}

/** One ticket carries its context: what done means, and where the work stands. */
export default function TicketContext(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="The ticket APP-2, Tenant id on every table, held by claude. Two of its three done-when criteria are ticked, and its worklog document moves to version 2 with what is done and what is next."
      title="Multi-tenancy › APP-2"
      meta="Details"
      timeline={[500, 1200, 2100, 2900]}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.main}>
            <div className={styles.title}>Tenant id on every table</div>
            <div className={styles.state}>
              <Chip tone="info">
                <StatusGlyph status="active" className={styles.stateGlyph} />
                In Progress
              </Chip>
              <span className={styles.holder}>
                <Agent name="claude" />
                claude
              </span>
            </div>
            <Label>Done when</Label>
            <ul className={styles.criteria}>
              {CRITERIA.map((text, i) => (
                <li key={text} className={clsx(styles.criterion, step >= i + 1 && i < 2 && styles.criterionMet)}>
                  <Check on={step >= i + 1 && i < 2} />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className={clsx(styles.worklog, step === 3 && styles.worklogLit)}>
            <Label className={styles.worklogHead}>
              <span className={styles.worklogName}>
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path d="M4 1.75h5.25L12.5 5v9.25h-8.5z M9 1.75V5.25h3.5M6 8.5h4.5M6 11h3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Worklog
              </span>
              <Swap on={step >= 3} align="end" before={<span className={styles.version}>Version 1</span>} after={<span className={styles.version}>Version 2</span>} />
            </Label>
            <dl className={styles.entries}>
              <div className={styles.entry}>
                <dt>Done</dt>
                <dd>
                  <Swap on={step >= 3} before="tenant_id on 4 of 14 tables" after="tenant_id on 9 of 14 tables, backfill script" block />
                </dd>
              </div>
              <div className={styles.entry}>
                <dt>Next</dt>
                <dd>
                  <Swap on={step >= 4} before="the remaining 10 tables, backfill script" after="invoices, payments, audit_log, sessions, api_keys" block />
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </Scene>
  );
}
