import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Agent, Chip, Label, List, Reveal, Row, Swap, Wide} from './parts';
import styles from './Handoff.module.css';

/** A session goes silent mid-ticket; another agent takes the claim over and reads the worklog. */
export default function Handoff(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="The ticket APP-2 is held by claude, which has been silent for 31 minutes. The agent codex takes the claim over and reads the worklog: what is done, and what is next."
      title="APP-2"
      meta="claim"
      timeline={[500, 1500, 2200, 3100]}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div>
            <List>
              <Row
                id={<Wide>APP-2</Wide>}
                status="active"
                title="Tenant id on every table"
                lit={step === 2}
                trail={
                  <Swap
                    on={step >= 2}
                    align="end"
                    before={
                      <>
                        <Swap on={step >= 1} align="end" before={<Chip tone="info">Working</Chip>} after={<Chip tone="warn">Silent 31m</Chip>} />
                        <Agent name="claude" />
                      </>
                    }
                    after={
                      <>
                        <Chip tone="info">Working</Chip>
                        <Agent name="codex" />
                      </>
                    }
                  />
                }
              />
            </List>
            <ol className={styles.events}>
              <li className={clsx(styles.event, styles.on)}>
                <span className={styles.who}>claude</span>
                <span>Claimed APP-2 and stored the worklog.</span>
              </li>
              <li className={clsx(styles.event, styles.warn, step >= 1 && styles.on)}>
                <span className={styles.who}>claude</span>
                <span>Session ended. Silent for 31 minutes.</span>
              </li>
              <li className={clsx(styles.event, styles.accent, step >= 2 && styles.on)}>
                <span className={styles.who}>codex</span>
                <span>Took the claim over, on the record.</span>
              </li>
            </ol>
          </div>

          <div className={styles.worklog}>
            <Label>
              <span className={styles.worklogName}>Worklog</span>
              <Reveal on={step >= 3} from="none" inline className={styles.read}>
                <span>staple doc APP-2 worklog</span>
              </Reveal>
            </Label>
            <dl className={styles.entries}>
              <div className={styles.entry}>
                <dt>Done</dt>
                <dd>tenant_id on 9 of 14 tables, backfill script</dd>
              </div>
              <div className={clsx(styles.entry, step >= 3 && styles.entryLit)}>
                <dt>Next</dt>
                <dd>invoices, payments, audit_log, sessions, api_keys</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </Scene>
  );
}
