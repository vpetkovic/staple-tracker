import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

type Props = {
  children: ReactNode;
  /** An internal route (`/docs`) or an external URL. */
  to: string;
  /** `primary` for the one main action in a view, `secondary` for the rest. */
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'lg';
  className?: string;
};

// A link styled as a button: every call to action on the site navigates.
export default function Button({children, to, variant = 'primary', size = 'md', className}: Props): ReactNode {
  return (
    <Link to={to} className={clsx(styles.button, styles[variant], size === 'lg' && styles.lg, className)}>
      {children}
    </Link>
  );
}

// Lays buttons out in a row that wraps on narrow screens.
export function ButtonRow({children, align = 'start'}: {children: ReactNode; align?: 'start' | 'center'}): ReactNode {
  return <div className={clsx(styles.row, align === 'center' && styles.center)}>{children}</div>;
}
