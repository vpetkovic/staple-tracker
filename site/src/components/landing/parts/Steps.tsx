import type {ReactNode} from 'react';
import clsx from 'clsx';
import {StatusGlyph} from '@site/src/components/scenes';
import {STEPS} from './content';
import styles from './Steps.module.css';

/**
 * From plan to done in three steps: one list of three cells, each with its number, the
 * status a ticket has at that point as the web UI draws it, a short title and one line.
 * Stacked on a phone, three across from 768 px. The step titles are not headings.
 *
 * A page restyles it with custom properties on the list (`className`): `--steps-outset`
 * (how far it reaches into the gutter), `--steps-radius`, `--steps-line` (the border and
 * the dividers), `--steps-ground`, and `--steps-title-font`, `--steps-title-weight`,
 * `--steps-title-tracking` for the titles.
 */
export default function Steps({className}: {className?: string}): ReactNode {
  return (
    <ol className={clsx(styles.steps, className)}>
      {STEPS.map((step, i) => (
        <li key={step.title} className={styles.step}>
          <div className={styles.stepTop} aria-hidden="true">
            <span className={styles.stepNumber}>{String(i + 1).padStart(2, '0')}</span>
            <StatusGlyph status={step.status} />
          </div>
          <p className={styles.stepTitle}>{step.title}</p>
          <p className={styles.stepText}>{step.text}</p>
        </li>
      ))}
    </ol>
  );
}
