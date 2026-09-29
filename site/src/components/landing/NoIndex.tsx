import type {ReactNode} from 'react';
import Head from '@docusaurus/Head';

// For the comparison copies of the landing page at /story and /classic: `/` is the
// page to index, whichever variant it serves.
export default function NoIndex(): ReactNode {
  return (
    <Head>
      <meta name="robots" content="noindex" />
    </Head>
  );
}
