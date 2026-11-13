import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Chip, List, Meter, Reveal, Row, Swap, Wide, type Status} from './parts';
import styles from './IdeaToShipped.module.css';

// Experimental planning, start to end: an idea is shaped, scheduled on a horizon,
// scaffolded into an epic and its tasks, and ships when the tasks are done.

const PHASES = ['Idea', 'Horizon', 'Epic + tasks', 'Shipped'];

// The breakdown rows that become tasks, and the step at which each is done.
const TASKS: {id: string; title: string; done: number; active?: number}[] = [
  {id: 'APP-14', title: 'Signup form with tenant name', done: 4},
  {id: 'APP-15', title: 'Provision the tenant schema', done: 5, active: 4},
  {id: 'APP-16', title: 'Welcome email to the owner', done: 6, active: 5},
];

/** Which phase a step is in: the idea, its horizon, its epic and tasks, then shipped. */
function phaseOf(step: number): number {
  if (step >= 7) return 3;
  if (step >= 3) return 2;
  if (step >= 2) return 1;
  return 0;
}

function stateChip(step: number): ReactNode {
  if (step >= 7) return <Chip tone="accent">✓ Shipped</Chip>;
  if (step >= 3) return <Chip tone="info">Epic · started</Chip>;
  if (step >= 1) return <Chip>Idea · shaped</Chip>;
  return <Chip>Idea · exploring</Chip>;
}

/** An idea becomes a plan, lands on a horizon, is scaffolded into an epic and its tasks, and ships. */
export default function IdeaToShipped(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="Experimental planning. The idea Tenant self-serve signup is marked shaped once its plan has all three required sections, scheduled on the horizon Beta, and scaffolded: it becomes the epic APP-13 with three tasks, APP-14 to APP-16. The tasks are done one by one, the horizon reads 3 of 3, and the epic reads Shipped."
      title="Plan"
      meta="experimental"
      timeline={[350, 800, 1300, 1800, 2300, 2800, 3300]}
      {...options}>
      {(step) => {
        const phase = phaseOf(step);
        const done = TASKS.filter((task) => step >= task.done).length;
        return (
          <>
            <ol className={styles.phases}>
              {PHASES.map((name, i) => (
                <li key={name} className={clsx(styles.phase, i < phase && styles.phasePast, i === phase && styles.phaseOn)}>
                  {name}
                </li>
              ))}
            </ol>

            <div className={clsx(styles.horizon, step >= 2 && styles.horizonOn)}>
              <span className={styles.diamond}>◇</span>
              <span className={styles.name}>Beta</span>
              <span className={styles.due}>
                <Wide>Due 12 Dec</Wide>
              </span>
              <span className={styles.figure}>
                <strong>{done}/3</strong>
              </span>
              <Meter value={done / 3} className={styles.meter} />
            </div>

            <List>
              <div className={clsx(styles.record, step >= 1 && step < 3 && styles.recordLit)}>
                <Reveal on={step >= 3} from="left" inline className={styles.recordId}>
                  APP-13
                </Reveal>
                <span className={styles.recordTitle}>Tenant self-serve signup</span>
                <Reveal on={step >= 2} from="none" inline className={styles.recordHorizon}>
                  <Wide>
                    <Chip>◇ Beta</Chip>
                  </Wide>
                </Reveal>
                <span className={styles.recordState}>{stateChip(step)}</span>
              </div>
              <div className={styles.plan}>
                <Swap
                  on={step >= 1}
                  before={
                    <>
                      Plan <strong>★ 2/3</strong> required<Wide>&nbsp;· acceptance criteria missing</Wide>
                    </>
                  }
                  after={
                    <>
                      Plan <strong>★ 3/3</strong> required<Wide>&nbsp;· 3 breakdown rows</Wide>
                    </>
                  }
                />
              </div>
              {TASKS.map((task) => {
                const status: Status = step >= task.done ? 'done' : task.active !== undefined && step >= task.active ? 'active' : 'ready';
                return <Row key={task.id} id={task.id} status={status} title={task.title} child shown={step >= 3} />;
              })}
            </List>
          </>
        );
      }}
    </Scene>
  );
}
