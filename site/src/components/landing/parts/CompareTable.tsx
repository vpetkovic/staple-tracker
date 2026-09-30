import type {ReactNode} from 'react';
import clsx from 'clsx';
import {COMPARE} from './content';
import styles from './CompareTable.module.css';

/** Your team's tracker and staple, side by side: who uses each, where it runs, what it holds. */
export default function CompareTable(): ReactNode {
  return (
    <table className={styles.compareTable}>
      <thead>
        <tr>
          <td />
          <th scope="col">Your team’s tracker</th>
          <th scope="col">staple</th>
        </tr>
      </thead>
      <tbody>
        {COMPARE.map((row) => (
          <tr key={row.term}>
            <th scope="row">{row.term}</th>
            <td>{row.tracker}</td>
            <td>{row.staple}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The chip on anything that is planned, not shipped. */
export function Planned({className}: {className?: string}): ReactNode {
  return <span className={clsx(styles.planned, className)}>Planned</span>;
}
