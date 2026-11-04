import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Chip, Label, Reveal, StatusGlyph} from './parts';
import styles from './Budget.module.css';

// A provider limit: how much of the window is used (the gauge), what is left (the figure), and when it resets.
const LIMITS: {name: string; used: number; resets: string}[] = [
  {name: '5-hour limit', used: 0.62, resets: 'resets in 1h 48m'},
  {name: 'Weekly limit', used: 0.41, resets: 'resets Thursday'},
];

/** Provider limits as gauges with the reserve marked, and an estimate against what the work took. */
export default function Budget(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="The Usage view: the 5-hour limit has 38% left and the weekly limit 59% left, and the pace keeps the 20% reserve. Below, the ticket APP-2 was estimated at 2 hours and took 1 hour 25 minutes of agent work."
      title="Usage"
      meta="this computer"
      timeline={[300, 800, 1700, 2500, 3300]}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.limits}>
            {LIMITS.map((limit, i) => (
              <div key={limit.name} className={styles.limit}>
                <div className={styles.limitHead}>
                  <span className={styles.limitName}>{limit.name}</span>
                  <span className={styles.limitMeta}>{limit.resets}</span>
                </div>
                <div className={styles.gauge}>
                  <span className={styles.gaugeFill} style={{transform: `scaleX(${step >= i + 1 ? limit.used : 0})`}} />
                  <span className={styles.reserve} />
                </div>
                <div className={styles.limitFoot}>
                  <Reveal on={step >= i + 1} from="none" inline className={styles.used}>
                    {Math.round((1 - limit.used) * 100)}% left
                  </Reveal>
                  <span className={styles.reserveNote}>reserve 20%</span>
                </div>
              </div>
            ))}
            <Reveal on={step >= 3} className={styles.verdict}>
              <Chip tone="accent">Your pace keeps the reserve</Chip>
            </Reveal>
          </div>

          <div className={styles.estimate}>
            <Label>Estimate against actual</Label>
            <div className={styles.ticket}>
              <StatusGlyph status="done" />
              <span className={styles.ticketId}>APP-2</span>
              <span className={styles.ticketTitle}>Tenant id on every table</span>
            </div>
            <div className={styles.bars}>
              <span className={styles.barLabel}>est</span>
              <span className={styles.track}>
                <span className={clsx(styles.bar, styles.barEstimate)} style={{transform: `scaleX(${step >= 4 ? 1 : 0})`}} />
              </span>
              <span className={styles.barValue}>2h</span>
              <span className={styles.barLabel}>ran</span>
              <span className={styles.track}>
                <span className={clsx(styles.bar, styles.barActual)} style={{transform: `scaleX(${step >= 5 ? 0.71 : 0})`}} />
              </span>
              <span className={styles.barValue}>1h 25m</span>
            </div>
          </div>
        </div>
      )}
    </Scene>
  );
}
