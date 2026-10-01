import type {ReactNode} from 'react';
import Head from '@docusaurus/Head';

// For pages that are not meant to be found: the scene review page
// (scenes/ScenesReview.tsx) uses it when it is given a route.
export default function NoIndex(): ReactNode {
  return (
    <Head>
      <meta name="robots" content="noindex" />
    </Head>
  );
}
