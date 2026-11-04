import type {ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Props = {
  children: ReactNode;
  /** `subtle` sets the section on the subtle surface with hairlines above and below. */
  tone?: 'default' | 'subtle';
  /** `narrow` caps the content at the reading measure. */
  width?: 'default' | 'narrow';
  /** `tight` halves the vertical padding. */
  spacing?: 'default' | 'tight';
  id?: string;
  className?: string;
};

// A full-width band with a centred, padded container: the unit a page is built from.
export default function Section({children, tone = 'default', width = 'default', spacing = 'default', id, className}: Props): ReactNode {
  return (
    <section id={id} className={clsx(styles.section, tone === 'subtle' && styles.subtle, spacing === 'tight' && styles.tight, className)}>
      <div className={clsx(styles.inner, width === 'narrow' && styles.narrow)}>{children}</div>
    </section>
  );
}
