import type {ReactNode} from 'react';
import Scene, {type SceneOptions} from './Scene';
import {Agent, Chip, List, Reveal, Row, Swap, Typed, Wide} from './parts';
import styles from './QueuePickup.module.css';

/** The pickup order: an agent asks what is next, gets the top ready ticket and claims it. */
export default function QueuePickup({fade = 'bottom', ...options}: SceneOptions): ReactNode {
  return (
    <Scene
      label="The pickup queue. The agent claude asks what is next and gets APP-2, the first ready ticket, and claims it. APP-3 is blocked, so APP-5 becomes next."
      title="Queue"
      meta="pickup order"
      timeline={[350, 1300, 2200, 3000]}
      fade={fade}
      {...options}>
      {(step) => (
        <>
          <div className={styles.ask}>
            <span className={styles.command}>
              <Agent name="claude" />
              <span className={styles.prompt}>$</span>
              <Typed on={step >= 1}>staple queue next</Typed>
            </span>
            <Reveal on={step >= 2} from="left" className={styles.answer}>
              next APP-2 (position 1)<Wide> Tenant id on every table</Wide>
            </Reveal>
          </div>
          <List>
            <Row
              lead="1"
              id="APP-2"
              status={step >= 3 ? 'active' : 'ready'}
              title="Tenant id on every table"
              lit={step >= 2}
              trail={
                <Swap
                  on={step >= 3}
                  align="end"
                  before={<Chip>Next up</Chip>}
                  after={
                    <>
                      <Wide>
                        <Chip tone="info">Working</Chip>
                      </Wide>
                      <Agent name="claude" />
                    </>
                  }
                />
              }
            />
            <Row lead="2" id="APP-3" status="backlog" title="Scope queries by tenant" dim trail={<Chip tone="danger">
                  Blocked<Wide>by 1</Wide>
                </Chip>} />
            <Row
              lead="3"
              id="APP-5"
              status="ready"
              title="Tenant-aware rate limits"
              trail={
                <Reveal on={step >= 4} from="none" inline>
                  <Chip>Next up</Chip>
                </Reveal>
              }
            />
            <Row lead="4" id="APP-4" status="backlog" title="Tenant-aware billing" dim trail={<Chip tone="danger">
                  Blocked<Wide>by 1</Wide>
                </Chip>} />
          </List>
        </>
      )}
    </Scene>
  );
}
