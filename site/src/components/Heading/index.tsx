import type {ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Level = 'h1' | 'h2' | 'h3' | 'h4' | 'p';
type Size = 'display' | 'xl' | 'lg' | 'md';

type Props = {
  children: ReactNode;
  /** The element, chosen for the document outline. */
  as?: Level;
  /** The visual size, chosen independently of the element. */
  size?: Size;
  align?: 'start' | 'center';
  id?: string;
  className?: string;
};

const defaultSize: Record<Level, Size> = {h1: 'display', h2: 'xl', h3: 'lg', h4: 'md', p: 'md'};

// The marketing type scale: display, xl, lg and md, each with its own tracking.
export default function Heading({children, as: Tag = 'h2', size, align = 'start', id, className}: Props): ReactNode {
  return (
    <Tag id={id} className={clsx(styles.heading, styles[size ?? defaultSize[Tag]], align === 'center' && styles.center, className)}>
      {children}
    </Tag>
  );
}

type LeadProps = {children: ReactNode; align?: 'start' | 'center'; className?: string};

// The paragraph that sits under a heading and says what the section is about.
export function Lead({children, align = 'start', className}: LeadProps): ReactNode {
  return <p className={clsx(styles.lead, align === 'center' && styles.center, className)}>{children}</p>;
}
