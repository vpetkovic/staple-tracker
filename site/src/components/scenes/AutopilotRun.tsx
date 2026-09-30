import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Agent, Chip, List, Reveal, Row, Swap, Wide, type Status} from './parts';
import styles from './AutopilotRun.module.css';

// When each ticket is taken and when it is done, as steps of the scene.
const TICKETS: {id: string; title: string; taken: number; done: number; waits?: number}[] = [
  {id: 'APP-2', title: 'Tenant id on every table', taken: 1, done: 2},
  {id: 'APP-3', title: 'Scope queries by tenant', taken: 2, done: 3, waits: 2},
  {id: 'APP-5', title: 'Tenant-aware rate limits', taken: 3, done: 4},
];

// `waits` is the step at which the ticket's blocker is done: before it, the ticket is not ready.
function statusAt(step: number, taken: number, done: number, waits = 0): Status {
  if (step >= done) return 'done';
  if (step >= taken) return 'active';
  return step >= waits ? 'ready' : 'backlog';
}

/** A run works an epic ticket after ticket, and its budget stops it. */
export default function AutopilotRun(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="An autopilot run by claude over the epic APP-1, with a budget of three tickets and sessions that close their own tickets. APP-2, APP-3 and APP-5 go done one after another, then the run stops: the budget is reached, and APP-4 is left ready."
      title="Autopilot run"
      meta={
        <>
          <Wide>--max-tickets 3 </Wide>--finish done
        </>
      }
      timeline={[350, 1150, 1950, 2750, 3450]}
      {...options}>
      {(step) => {
        // The run counts a ticket against its budget when it takes it.
        const taken = Math.min(3, step);
        return (
          <>
            <div className={styles.head}>
              <span className={styles.who}>
                <Agent name="claude" />
                <span className={styles.scope}>claude over APP-1</span>
              </span>
              <span className={styles.count}>{taken}/3 tickets</span>
            </div>
            <div className={styles.budget}>
              {[1, 2, 3].map((n) => (
                <span key={n} className={clsx(styles.slot, taken >= n && styles.slotOn)} />
              ))}
            </div>
            <List>
              {TICKETS.map((ticket) => {
                const status = statusAt(step, ticket.taken, ticket.done, ticket.waits);
                return (
                  <Row
                    key={ticket.id}
                    id={ticket.id}
                    status={status}
                    title={ticket.title}
                    lit={status === 'active'}
                    dim={status === 'done' || status === 'backlog'}
                    trail={
                      <Wide>
                        <Reveal on={status === 'active'} from="none" inline>
                          <Chip tone="info">Autopilot</Chip>
                        </Reveal>
                      </Wide>
                    }
                  />
                );
              })}
              <Row id="APP-4" status={step >= 3 ? 'ready' : 'backlog'} title="Tenant-aware billing" dim={step < 3} />
            </List>
            <div className={styles.foot}>
              <Swap
                on={step >= 5}
                before={<span className={styles.running}>Running. After each ticket, staple decides whether it goes on.</span>}
                after={
                  <>
                    <Chip tone="warn">Stopped: budget</Chip>
                    <span className={styles.reason}>3 of 3 tickets used</span>
                  </>
                }
                block
              />
            </div>
          </>
        );
      }}
    </Scene>
  );
}
