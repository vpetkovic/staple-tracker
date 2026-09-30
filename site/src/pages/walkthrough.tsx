import type {ReactNode} from 'react';
import Walkthrough from '@site/src/components/landing/Walkthrough';
import NoIndex from '@site/src/components/landing/NoIndex';

// The walkthrough landing page, for comparison whichever variant `/` serves.
export default function WalkthroughPage(): ReactNode {
  return (
    <>
      <NoIndex />
      <Walkthrough />
    </>
  );
}
