import {preload} from 'react-dom';
import useIsBrowser from '@docusaurus/useIsBrowser';
import serifRoman from '@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2';
import serifItalic from '@fontsource-variable/fraunces/files/fraunces-latin-opsz-italic.woff2';
import './serif.css';

/**
 * The serif display face, for the pages that set headlines in `--st-font-serif` (bento
 * and blend). Render it once inside the page's `Layout`: it declares the face and
 * fetches the two files early. A page that does not render it never downloads them.
 *
 * The preloads go through React's `preload`, not `Head`: React writes them into the
 * server-rendered page and leaves them alone on hydration, where the head manager
 * replaced its own links now and then, which fetched both files a second time and left
 * the browser warning that the first two were preloaded but not used. They are only for
 * the server-rendered page (and its hydration, which finds them there): arriving from
 * another page of the site, the stylesheet has already asked for the files by the time
 * a preload would, and a late preload fetched them a second time.
 */
export default function SerifFont(): null {
  const hydrated = useIsBrowser();
  if (!hydrated) {
    preload(serifRoman, {as: 'font', type: 'font/woff2', crossOrigin: 'anonymous'});
    preload(serifItalic, {as: 'font', type: 'font/woff2', crossOrigin: 'anonymous'});
  }
  return null;
}
