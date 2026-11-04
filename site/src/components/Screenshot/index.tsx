import type {CSSProperties, ReactNode} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {ThemedComponent} from '@docusaurus/theme-common';
import styles from './styles.module.css';

type Props = {
  /** The file stem under static/img/screens: `<name>-light.webp` and `<name>-dark.webp`. */
  name: string;
  /** What the screenshot shows, for people who cannot see it. */
  alt: string;
  /** A short caption under the frame. */
  caption?: ReactNode;
  /**
   * Below 768 px, show the web UI's own phone layout instead of the desk capture:
   * `<name>-phone-light.webp` and `<name>-phone-dark.webp`, 390 x 560 CSS pixels at 2x.
   */
  phone?: boolean;
  /**
   * Without a phone capture, a phone shows a zoomed crop of the desk capture whose
   * top-left corner sits at this point, in percent of the image's width and height.
   */
  focus?: {x: number; y: number};
  /** The hero image loads eagerly; every other one lazily. */
  priority?: boolean;
  className?: string;
};

// The desk captures are 1280 x 800 CSS pixels at 2x; the phone captures 390 x 560 at 2x.
const DESK = {width: 2560, height: 1600};
const PHONE = {width: 780, height: 1120};
// The breakpoint of the page (use-media 768): below it, the phone capture.
const PHONE_MEDIA = '(max-width: 767px)';

// A product screenshot in a hairline frame, in the variant that matches the theme.
export default function Screenshot({
  name,
  alt,
  caption,
  phone = false,
  focus = {x: 0, y: 0},
  priority = false,
  className,
}: Props): ReactNode {
  const desk = {light: useBaseUrl(`/img/screens/${name}-light.webp`), dark: useBaseUrl(`/img/screens/${name}-dark.webp`)};
  const small = {
    light: useBaseUrl(`/img/screens/${name}-phone-light.webp`),
    dark: useBaseUrl(`/img/screens/${name}-phone-dark.webp`),
  };
  return (
    <figure className={clsx(styles.figure, phone && styles.hasPhone, className)}>
      <div className={styles.frame} style={{'--focus-x': `${-focus.x}%`, '--focus-y': `${-focus.y}%`} as CSSProperties}>
        <div className={styles.crop}>
          <ThemedComponent>
            {({theme, className: themed}) => (
              <picture className={themed}>
                {phone && (
                  <source media={PHONE_MEDIA} srcSet={small[theme]} width={PHONE.width} height={PHONE.height} />
                )}
                <img
                  className={styles.image}
                  src={desk[theme]}
                  alt={alt}
                  width={DESK.width}
                  height={DESK.height}
                  loading={priority ? 'eager' : 'lazy'}
                  decoding="async"
                  {...(priority ? {fetchPriority: 'high' as const} : {})}
                />
              </picture>
            )}
          </ThemedComponent>
        </div>
      </div>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}
