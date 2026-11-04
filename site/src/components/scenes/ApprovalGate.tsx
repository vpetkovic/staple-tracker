import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Chip, List, Pointer, Row, Swap, Wide} from './parts';
import styles from './ApprovalGate.module.css';

/** An epic waits on a person. Approve all is pressed, and the tickets under it become ready. */
export default function ApprovalGate(options: SceneOptions): ReactNode {
  const approved = (step: number) => step >= 3;
  return (
    <Scene
      label="The epic APP-1 Multi-tenancy is gated: it waits for VP's approval, and the tickets under it wait with it. Approve all is pressed: the gate is approved. APP-3 and APP-5 become ready; APP-4 still waits on APP-3."
      title="APP-1"
      meta="approval gate"
      timeline={[450, 1350, 1650, 2300, 2700, 3300]}
      {...options}>
      {(step) => (
        <>
          <div className={styles.gate}>
            <List className={styles.gateRow}>
              <Row
                id="APP-1"
                status={approved(step) ? 'backlog' : 'gated'}
                title="Multi-tenancy"
                epic
                trail={<Swap on={approved(step)} align="end" before={<Chip tone="danger">Awaiting VP</Chip>} after={<Chip tone="accent">Gate approved</Chip>} />}
              />
            </List>
            <div className={styles.ask}>
              <p className={styles.note}>Review the tenant id design before queries build on it.</p>
              <span className={styles.action}>
                <span className={clsx(styles.button, step === 2 && styles.pressed, approved(step) && styles.gone)}>
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path d="M3.5 8.4 6.6 11.4 12.5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Approve all
                </span>
                <span className={clsx(styles.signed, approved(step) && styles.signedOn)}>Approved by VP</span>
                <Pointer className={clsx(styles.pointer, step >= 1 && step < 4 && styles.pointerOn, step === 2 && styles.pointerDown)} />
              </span>
            </div>
          </div>

          <List>
            <Row
              id="APP-3"
              status={step >= 4 ? 'ready' : 'backlog'}
              title="Scope queries by tenant"
              child
              dim={step < 4}
              trail={<Swap on={step >= 4} align="end" before={<Chip>Waits<Wide>for VP</Wide></Chip>} after={<Chip tone="accent">Ready</Chip>} />}
            />
            <Row
              id="APP-5"
              status={step >= 5 ? 'ready' : 'backlog'}
              title="Tenant-aware rate limits"
              child
              dim={step < 5}
              trail={<Swap on={step >= 5} align="end" before={<Chip>Waits<Wide>for VP</Wide></Chip>} after={<Chip tone="accent">Ready</Chip>} />}
            />
            <Row
              id="APP-4"
              status="backlog"
              title="Tenant-aware billing"
              child
              dim
              trail={<Swap on={step >= 5} align="end" before={<Chip>Waits<Wide>for VP</Wide></Chip>} after={<Chip tone="danger">Blocked<Wide>by 1</Wide></Chip>} />}
            />
          </List>
        </>
      )}
    </Scene>
  );
}
