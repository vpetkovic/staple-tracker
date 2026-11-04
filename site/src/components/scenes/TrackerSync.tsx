import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Agent, Chip, Label, List, Reveal, Row} from './parts';
import styles from './TrackerSync.module.css';

// The integrations that are planned. None of them is shipped, and the scene never
// shows one without saying so.
const TRACKERS = ['GitHub Issues', 'ClickUp', 'Linear'];

/** staple next to a team's tracker, with the sync between them marked as planned. */
export default function TrackerSync({fade = 'bottom', ...options}: SceneOptions): ReactNode {
  return (
    <Scene
      label="staple, the local execution layer, beside a team's tracker. Sync with GitHub Issues, ClickUp and Linear is planned, not shipped: each one is marked Planned."
      title="Next to your team's tracker"
      meta="planned"
      timeline={[350, 700, 1050, 1800, 2600]}
      fade={fade}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.side}>
            <Label>Your team’s tracker</Label>
            <div className={styles.trackers}>
              {TRACKERS.map((name, i) => (
                <Reveal key={name} on={step >= i + 1} className={styles.tracker}>
                  <svg className={styles.board} viewBox="0 0 16 16" width="16" height="16">
                    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
                    <path d="M6 2.75v10.5M10 2.75v10.5" />
                  </svg>
                  <span className={styles.trackerName}>{name}</span>
                  <Chip tone="planned">Planned</Chip>
                </Reveal>
              ))}
            </div>
          </div>

          <div className={clsx(styles.bridge, step >= 4 && styles.bridgeOn)}>
            <span className={styles.dash} />
            <Reveal on={step >= 5} from="none" className={styles.bridgeLabel}>
              <span>Sync</span>
              <Chip tone="planned">Planned</Chip>
            </Reveal>
            <span className={styles.dash} />
          </div>

          <div className={styles.side}>
            <Label>
              <span>staple</span>
              <span className={styles.local}>local</span>
            </Label>
            <List>
              <Row id="APP-2" status="active" title="Tenant id on every table" trail={<Agent name="claude" />} />
              <Row id="APP-3" status="backlog" title="Scope queries by tenant" dim />
              <Row id="APP-5" status="ready" title="Tenant-aware rate limits" />
              <Row id="APP-4" status="backlog" title="Tenant-aware billing" dim />
            </List>
          </div>
        </div>
      )}
    </Scene>
  );
}
