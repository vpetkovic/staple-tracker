import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Agent, List, Reveal, Row, Swap, Typed} from './parts';
import styles from './OneStore.module.css';

/** One store behind the CLI, the web UI and the MCP tools: a change in one shows in all. */
export default function OneStore(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="One store behind three surfaces. The command staple done APP-2 runs in a terminal; the same ticket turns done in the web UI's row and in the answer of the MCP tool get_task."
      title="One SQLite file"
      meta="CLI · web UI · MCP"
      timeline={[300, 1250, 1750, 2250, 3200]}
      {...options}>
      {(step) => (
        <>
          <span className={clsx(styles.store, step >= 2 && step < 5 && styles.storeLit)}>
            <svg viewBox="0 0 16 16" width="14" height="14">
              <ellipse cx="8" cy="4" rx="5.25" ry="2.25" />
              <path d="M2.75 4v8c0 1.24 2.35 2.25 5.25 2.25s5.25-1 5.25-2.25V4M2.75 8c0 1.24 2.35 2.25 5.25 2.25s5.25-1 5.25-2.25" />
            </svg>
            The store
          </span>

          <div className={styles.tree}>
            <div className={clsx(styles.branch, (step === 1 || step === 2) && styles.branchLit)}>
              <span className={styles.tag}>CLI</span>
              <div className={styles.code}>
                <div className={styles.codeLine}>
                  <span className={styles.prompt}>$</span>
                  <Typed on={step >= 1}>staple done APP-2</Typed>
                </div>
                <Reveal on={step >= 2} from="none" className={clsx(styles.codeLine, styles.output)}>
                  <span className={styles.done}>●</span>
                  <span className={styles.clip}>APP-2 done Tenant id on every table</span>
                </Reveal>
              </div>
            </div>

            <div className={clsx(styles.branch, step === 3 && styles.branchLit)}>
              <span className={styles.tag}>Web UI</span>
              <List className={styles.ui}>
                <Row id="APP-2" status={step >= 3 ? 'done' : 'active'} title="Tenant id on every table" trail={<Agent name="codex" />} />
              </List>
            </div>

            <div className={clsx(styles.branch, step === 4 && styles.branchLit)}>
              <span className={styles.tag}>MCP</span>
              <div className={styles.code}>
                <div className={styles.codeLine}>
                  <span className={styles.key}>get_task</span>
                  <span>APP-2</span>
                </div>
                <div className={clsx(styles.codeLine, styles.output)}>
                  <span className={styles.key}>status</span>
                  <Swap on={step >= 4} before="in_progress" after={<span className={styles.done}>done</span>} />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Scene>
  );
}
