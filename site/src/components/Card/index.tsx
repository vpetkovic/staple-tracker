import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

type Props = {
  title: ReactNode;
  children?: ReactNode;
  /** A small label above the title. */
  eyebrow?: ReactNode;
  /** Makes the whole card a link. */
  to?: string;
  /** The title element, to fit the page outline (h3 under an h2, h2 under the h1). */
  titleAs?: 'h2' | 'h3' | 'h4';
  className?: string;
};

// A hairline-bordered panel. With `to`, the whole card is the link target.
export default function Card({title, children, eyebrow, to, titleAs: Title = 'h3', className}: Props): ReactNode {
  const body = (
    <>
      {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
      <Title className={styles.title}>
        {title}
        {to && (
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
        )}
      </Title>
      {children && <div className={styles.body}>{children}</div>}
    </>
  );
  return to ? (
    <Link to={to} className={clsx(styles.card, styles.link, className)}>
      {body}
    </Link>
  ) : (
    <div className={clsx(styles.card, className)}>{body}</div>
  );
}

// A grid of cards: one column on phones, `columns` from tablets up.
export function CardGrid({children, columns = 3}: {children: ReactNode; columns?: 2 | 3}): ReactNode {
  return <div className={clsx(styles.grid, columns === 2 && styles.two)}>{children}</div>;
}
