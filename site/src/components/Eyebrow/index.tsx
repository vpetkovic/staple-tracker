import type {ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Props = {children: ReactNode; className?: string};

// The small label above a heading: names the section before the heading makes the point.
export default function Eyebrow({children, className}: Props): ReactNode {
  return <p className={clsx(styles.eyebrow, className)}>{children}</p>;
}
