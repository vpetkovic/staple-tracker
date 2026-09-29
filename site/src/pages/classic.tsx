import type {ReactNode} from 'react';
import Classic from '@site/src/components/landing/Classic';
import NoIndex from '@site/src/components/landing/NoIndex';

// The classic landing page, for comparison whichever variant `/` serves.
export default function ClassicPage(): ReactNode {
  return (
    <>
      <NoIndex />
      <Classic />
    </>
  );
}
