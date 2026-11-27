import type {CSSProperties, ReactNode} from 'react';
import Scene, {type SceneOptions} from './Scene';
import {Chip, Label, Reveal} from './parts';
import styles from './Analytics.module.css';

// The three figures the Overview leads with: what is measured, the figure, and what it means.
const FIGURES: {label: string; value: string; unit?: string; note: string}[] = [
  {label: 'Agent time', value: '86', unit: 'h', note: 'about 1 full-time engineer'},
  {label: 'Features', value: '4', note: 'shipped, 61 tickets'},
  {label: 'Time to done', value: '1.2', unit: 'h', note: 'typical ticket'},
];

// Agent hours per day, stacked by workspace: [app, api], as shares of the tallest day.
const DAYS: [number, number][] = [
  [0.18, 0.06],
  [0.42, 0.12],
  [0.3, 0.3],
  [0.08, 0.04],
  [0.5, 0.22],
  [0.62, 0.38],
  [0.24, 0.1],
  [0.36, 0.44],
  [0.12, 0.08],
  [0.46, 0.2],
];

/** The Analytics overview: three figures arrive, then agent time per day stacks up by workspace. */
export default function Analytics(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="The Analytics view for the last 30 days, across every workspace: agents logged 86 hours, about one full-time engineer; 4 features shipped from 61 closed tickets; a typical ticket took 1.2 hours from claim to done. Below, agent time per day stacked by workspace, with up to 4 agents working at once."
      title="Analytics"
      meta="last 30 days"
      timeline={[300, 800, 1300, 2000, 2900]}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.figures}>
            {FIGURES.map((figure, i) => (
              <Reveal key={figure.label} on={step >= i + 1} className={styles.figure}>
                <span className={styles.figureLabel}>{figure.label}</span>
                <span className={styles.figureValue}>
                  {figure.value}
                  {figure.unit && <span className={styles.figureUnit}>{figure.unit}</span>}
                </span>
                <span className={styles.figureNote}>{figure.note}</span>
              </Reveal>
            ))}
          </div>

          <div className={styles.chart}>
            <Label>
              <span>Agent time per day</span>
              <span className={styles.legend}>
                <span className={styles.key}>
                  <i className={styles.swatchApp} />
                  app
                </span>
                <span className={styles.key}>
                  <i className={styles.swatchApi} />
                  api
                </span>
              </span>
            </Label>
            <div className={styles.plot}>
              {DAYS.map(([app, api], i) => (
                <span key={i} className={styles.slot}>
                  <span className={styles.column} style={{'--i': i, height: `${(app + api) * 100}%`, transform: `scaleY(${step >= 4 ? 1 : 0})`} as CSSProperties}>
                    <span className={styles.segApi} style={{flexGrow: api}} />
                    <span className={styles.segApp} style={{flexGrow: app}} />
                  </span>
                </span>
              ))}
            </div>
            <Reveal on={step >= 5} className={styles.verdict}>
              <Chip tone="info">Up to 4 agents at once</Chip>
            </Reveal>
          </div>
        </div>
      )}
    </Scene>
  );
}
