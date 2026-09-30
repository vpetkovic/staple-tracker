import type {ReactNode} from 'react';
import CopyCommand from '@site/src/components/CopyCommand';
import styles from './Install.module.css';

/** The install command in a small terminal window, with its copy button. */
export default function Install(): ReactNode {
  return (
    <div className={styles.install}>
      <div className={styles.installBar} aria-hidden="true">
        <span>~/your-repository</span>
        <span>terminal</span>
      </div>
      <CopyCommand command="npx staple-cli" variant="secondary" className={styles.command} />
    </div>
  );
}
