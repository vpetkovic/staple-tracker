import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Chip, Label, Reveal, Swap, Wide} from './parts';
import styles from './ReturnOnSpend.module.css';

// The people the work would have needed, read from its tickets: what hiring each would cost
// (by agent time) and what was paid for AI to do that work instead.
const ROLES: {title: string; tickets: number; hire: string; ai: string}[] = [
  {title: 'Software Engineer', tickets: 48, hire: '$6,200', ai: '$400'},
  {title: 'Design Engineer', tickets: 9, hire: '$1,450', ai: '$20'},
  {title: 'Technical Writer', tickets: 4, hire: '$750', ai: '—'},
];

// Where the two counts sit on the scale, as shares of its width: break-even, the low end, the high end.
const BREAK_EVEN = 0.132;
const LOW = 0.33;
const HIGH = 0.87;

/** The Return lens: the team the tickets would have needed against the AI instead, and the return on total cost. */
export default function ReturnOnSpend(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="The Return lens of Analytics. Role by role, read from the tickets: a Software Engineer would have cost 6,200 dollars to hire against 400 dollars of AI, a Design Engineer 1,450 against 20, a Technical Writer 750. With the time spent directing the agents, the work cost 3,300 dollars and would have cost 8,400 to 21,700 to hire: a return of 2.5 to 6.6 times on total cost, which paid for itself."
      title="Analytics · Return"
      meta="profile: just me"
      timeline={[300, 800, 1300, 1800, 2500, 3300]}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.roles}>
            <Label>
              <span>Role by role</span>
              <span className={styles.heads}>
                <span>to hire</span>
                <span>with AI</span>
              </span>
            </Label>
            {ROLES.map((role, i) => (
              <Reveal key={role.title} on={step >= i + 1} className={styles.role}>
                <span className={styles.roleName}>
                  {role.title}
                  <Wide>
                    <span className={styles.roleTickets}> · {role.tickets} tickets</span>
                  </Wide>
                </span>
                <span className={styles.amount}>{role.hire}</span>
                <span className={clsx(styles.amount, styles.amountAi)}>{role.ai}</span>
              </Reveal>
            ))}
            <Reveal on={step >= 4} className={clsx(styles.role, styles.person)}>
              <span className={styles.roleName}>Your time, directing</span>
              <span className={styles.amount} />
              <span className={clsx(styles.amount, styles.amountAi)}>$2,880</span>
            </Reveal>
          </div>

          <div className={styles.answer}>
            <div className={styles.figure}>
              <Swap on={step >= 5} before={<span className={styles.figureWait}>…</span>} after={<span className={styles.figureValue}>2.5–6.6×</span>} />
              <span className={styles.figureLabel}>return on total cost</span>
            </div>
            <div className={styles.scale}>
              <span className={styles.below} style={{width: `${BREAK_EVEN * 100}%`}} />
              <span className={styles.band} style={{left: `${LOW * 100}%`, width: `${(HIGH - LOW) * 100}%`, transform: `scaleX(${step >= 5 ? 1 : 0})`}} />
              <span className={clsx(styles.dot, step >= 5 && styles.dotOn)} style={{left: `${LOW * 100}%`}} />
              <span className={clsx(styles.dot, step >= 5 && styles.dotOn)} style={{left: `${HIGH * 100}%`}} />
              <span className={styles.tick} style={{left: `${BREAK_EVEN * 100}%`}} />
            </div>
            <div className={styles.scaleFoot}>
              <span className={styles.breakEven} style={{left: `${BREAK_EVEN * 100}%`}}>
                1× break-even
              </span>
            </div>
            <Reveal on={step >= 6} className={styles.verdict}>
              <Chip tone="accent">Paid for itself</Chip>
            </Reveal>
          </div>
        </div>
      )}
    </Scene>
  );
}
