import type {ReactNode} from 'react';
import Head from '@docusaurus/Head';

// For the comparison copies of the landing page at /story, /classic, /bento,
// /walkthrough and /blend (`/` is the page to index, whichever variant it serves) and for
// the scene review page at /scenes.
export default function NoIndex(): ReactNode {
  return (
    <Head>
      <meta name="robots" content="noindex" />
    </Head>
  );
}
