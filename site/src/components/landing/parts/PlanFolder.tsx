import type {ReactNode} from 'react';
import {Reveal, Scene} from '@site/src/components/scenes';
import styles from './PlanFolder.module.css';

// The folder from docs/why-staple.md: plans that point at each other. `step` is when
// a file's note appears.
const PLAN_FILES: {name: string; note?: string; step?: number}[] = [
  {name: 'brainstorm-rate-limits.md'},
  {name: 'plan-auth-refactor.md', note: 'blocked until tenant ids land, see plan-multi-tenancy.md', step: 1},
  {name: 'plan-multi-tenancy.md', note: 'step 4 depends on plan-auth-refactor.md, step 2', step: 2},
  {name: 'plan-multi-tenancy-v2.md', note: 'replaces parts of plan-multi-tenancy.md', step: 3},
  {name: 'plan-tenant-billing.md'},
];

/** The problem as a piece of UI: the notes that tie the plans together appear, then the session ends. */
export default function PlanFolder(): ReactNode {
  return (
    <Scene
      label="A folder of five Markdown plans. Three of them carry notes that point at the others: one is blocked until another lands, one depends on a step of another, one replaces parts of another. Then the session ends mid-feature."
      title="docs/plans/"
      meta={`${PLAN_FILES.length} files`}
      timeline={[500, 1200, 1900, 2900]}>
      {(step) => (
        <div className={styles.folder}>
          {PLAN_FILES.map((file) => (
            <div key={file.name} className={styles.file}>
              <svg className={styles.fileIcon} viewBox="0 0 16 16" width="16" height="16">
                <path d="M4 1.75h5.25L12.5 5v9.25h-8.5z M9 1.75V5.25h3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
              </svg>
              <span className={styles.fileName}>{file.name}</span>
              {file.note && (
                <Reveal on={step >= (file.step ?? 0)} from="left" className={styles.fileNote}>
                  “{file.note}”
                </Reveal>
              )}
            </div>
          ))}
          <Reveal on={step >= 4} className={styles.folderEnd}>
            <span className={styles.folderEndMark} />
            Session ended mid-feature: usage limit reached.
          </Reveal>
        </div>
      )}
    </Scene>
  );
}
