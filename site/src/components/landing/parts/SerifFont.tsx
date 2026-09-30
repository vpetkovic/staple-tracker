import type {ReactNode} from 'react';
import Head from '@docusaurus/Head';
import serifRoman from '@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2';
import serifItalic from '@fontsource-variable/fraunces/files/fraunces-latin-opsz-italic.woff2';
import './serif.css';

/**
 * The serif display face, for the pages that set headlines in `--st-font-serif` (bento
 * and blend). Render it once inside the page's `Layout`: it declares the face and
 * fetches the two files early. A page that does not render it never downloads them.
 */
export default function SerifFont(): ReactNode {
  return (
    <Head>
      <link rel="preload" href={serifRoman} as="font" type="font/woff2" crossOrigin="anonymous" />
      <link rel="preload" href={serifItalic} as="font" type="font/woff2" crossOrigin="anonymous" />
    </Head>
  );
}
