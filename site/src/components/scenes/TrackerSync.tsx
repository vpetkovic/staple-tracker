import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Agent, Chip, Label, List, Reveal, Row} from './parts';
import styles from './TrackerSync.module.css';

// What staple reads today and what is still to come. Nothing here is shown as shipped
// unless it is: every tracker listed is read today, and writing back says Planned.
const TRACKERS = [
  {name: 'GitHub', shipped: true},
  {name: 'Linear', shipped: true},
  {name: 'Azure DevOps', shipped: true},
  {name: 'ClickUp', shipped: true},
];

/** staple next to a team's tracker: what it reads today, and writing back marked as planned. */
export default function TrackerSync({fade = 'bottom', ...options}: SceneOptions): ReactNode {
  return (
    <Scene
      label="staple, the local execution layer, beside a team's tracker. staple reads from GitHub, Linear, Azure DevOps and ClickUp today, each marked Shipped. Writing back to the tracker is planned, marked Planned."
      title="Next to your team's tracker"
      meta="read-only"
      timeline={[350, 700, 1050, 1400, 2150, 2950]}
      fade={fade}
      {...options}>
      {(step) => (
        <div className={styles.wrap}>
          <div className={styles.side}>
            <Label>Your team’s tracker</Label>
            <div className={styles.trackers}>
              {TRACKERS.map(({name, shipped}, i) => (
                <Reveal key={name} on={step >= i + 1} className={styles.tracker}>
                  <svg className={styles.board} viewBox="0 0 16 16" width="16" height="16">
                    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
                    <path d="M6 2.75v10.5M10 2.75v10.5" />
                  </svg>
                  <span className={styles.trackerName}>{name}</span>
                  {shipped ? <Chip tone="accent">Shipped</Chip> : <Chip tone="planned">Planned</Chip>}
                </Reveal>
              ))}
            </div>
          </div>

          <div className={clsx(styles.bridge, step >= 5 && styles.bridgeOn)}>
            <span className={styles.dash} />
            <Reveal on={step >= 6} from="none" className={styles.bridgeLabels}>
              <span className={styles.bridgeLabel}>
                <span>Reads</span>
                <Chip tone="accent">Shipped</Chip>
              </span>
              <span className={styles.bridgeLabel}>
                <span>Writes back</span>
                <Chip tone="planned">Planned</Chip>
              </span>
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
