import type {ReactNode} from 'react';
import Bento from '@site/src/components/landing/Bento';
import NoIndex from '@site/src/components/landing/NoIndex';

// The bento landing page, for comparison whichever variant `/` serves.
export default function BentoPage(): ReactNode {
  return (
    <>
      <NoIndex />
      <Bento />
    </>
  );
}
