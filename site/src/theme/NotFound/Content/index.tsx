import type {ReactNode} from 'react';
import clsx from 'clsx';
import Eyebrow from '@site/src/components/Eyebrow';
import Heading, {Lead} from '@site/src/components/Heading';
import Button, {ButtonRow} from '@site/src/components/Button';
import styles from './styles.module.css';

// What a missing address shows: where you are, and the two ways back.
export default function NotFoundContent({className}: {className?: string}): ReactNode {
  return (
    <main className={clsx(styles.page, className)}>
      <Eyebrow className={styles.eyebrow}>404</Eyebrow>
      <Heading as="h1" size="xl" align="center" className={styles.title}>
        There is no page at this address.
      </Heading>
      <Lead align="center" className={styles.lead}>
        The link may be old or mistyped. The documentation starts from its overview, and the search in the bar above
        covers every page.
      </Lead>
      <ButtonRow align="center">
        <Button to="/docs" size="lg">
          Documentation
        </Button>
        <Button to="/" variant="secondary" size="lg">
          Home
        </Button>
      </ButtonRow>
    </main>
  );
}
