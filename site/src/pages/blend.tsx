import type {ReactNode} from 'react';
import Blend from '@site/src/components/landing/Blend';
import NoIndex from '@site/src/components/landing/NoIndex';

// The blend landing page, for comparison whichever variant `/` serves.
export default function BlendPage(): ReactNode {
  return (
    <>
      <NoIndex />
      <Blend />
    </>
  );
}
