import type {ReactNode} from 'react';
import clsx from 'clsx';
import Scene, {type SceneOptions} from './Scene';
import {Chip, Meter, Reveal, StatusGlyph, Wide} from './parts';
import styles from './MilestoneGoal.module.css';

// The goal: each criterion, the step at which it is marked met, and its evidence.
const CRITERIA: {text: string; evidence?: string; lit?: number; met?: number}[] = [
  {text: 'Every table carries a tenant id', evidence: 'APP-2', lit: 1, met: 2},
  {text: 'Every query is scoped to one tenant', evidence: 'APP-3', lit: 3, met: 4},
  {text: 'Billing is per tenant'},
];

/** A milestone's goal: criteria marked met with evidence, and the progress they add up to. */
export default function MilestoneGoal(options: SceneOptions): ReactNode {
  return (
    <Scene
      label="The milestone Multi-tenant beta and its goal of three criteria. Two are marked met, each with a finished ticket as evidence, APP-2 and APP-3; the third is still unknown. The goal reads 2 of 3 met."
      title="Milestone"
      meta="goal"
      timeline={[450, 1050, 1900, 2500, 3200]}
      {...options}>
      {(step) => {
        const met = CRITERIA.filter((c) => c.met !== undefined && step >= c.met).length;
        return (
          <>
            <div className={styles.head}>
              <span className={styles.name}>Multi-tenant beta</span>
              <span className={styles.due}>
                <Wide>Due 14 Nov</Wide>
              </span>
              <Chip tone="info">In progress</Chip>
            </div>
            <div className={styles.progress}>
              <span className={styles.figure}>
                Goal <strong>{met}/3</strong> met
              </span>
              <Meter value={met / 3} className={styles.meter} />
            </div>
            <ul className={styles.criteria}>
              {CRITERIA.map((criterion, i) => {
                const isMet = criterion.met !== undefined && step >= criterion.met;
                const isLit = criterion.lit !== undefined && step >= criterion.lit && step < (criterion.met ?? 0) + 1 && step < 5;
                return (
                  <li key={criterion.text} className={clsx(styles.criterion, isLit && styles.criterionLit)}>
                    <StatusGlyph status={isMet ? 'done' : 'backlog'} className={styles.verdict} />
                    <span className={styles.text}>
                      <span className={styles.number}>{i + 1}.</span> {criterion.text}
                    </span>
                    {criterion.evidence ? (
                      <Reveal on={isMet} from="left" inline className={styles.evidence}>
                        <Chip tone="accent">{criterion.evidence}</Chip>
                      </Reveal>
                    ) : (
                      <span className={styles.unknown}>unknown</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        );
      }}
    </Scene>
  );
}
