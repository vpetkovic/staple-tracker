import type {ReactNode} from 'react';
import Story from '@site/src/components/landing/Story';
import NoIndex from '@site/src/components/landing/NoIndex';

// The story landing page, for comparison whichever variant `/` serves.
export default function StoryPage(): ReactNode {
  return (
    <>
      <NoIndex />
      <Story />
    </>
  );
}
