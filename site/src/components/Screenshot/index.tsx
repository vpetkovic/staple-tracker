import type {CSSProperties, ReactNode} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';
import ThemedImage from '@theme/ThemedImage';
import styles from './styles.module.css';

type Props = {
  /** The file stem under static/img/screens: `<name>-light.webp` and `<name>-dark.webp`. */
  name: string;
  /** What the screenshot shows, for people who cannot see it. */
  alt: string;
  /** A short caption under the frame. */
  caption?: ReactNode;
  /**
   * Where a phone looks: below 768 px the frame shows a zoomed crop whose top-left
   * corner sits at this point, in percent of the image's width and height.
   */
  focus?: {x: number; y: number};
  /** The hero image loads eagerly; every other one lazily. */
  priority?: boolean;
  className?: string;
};

// The captures are 1280 x 800 CSS pixels at 2x.
const WIDTH = 2560;
const HEIGHT = 1600;

// A product screenshot in a hairline frame, in the variant that matches the theme.
export default function Screenshot({
  name,
  alt,
  caption,
  focus = {x: 0, y: 0},
  priority = false,
  className,
}: Props): ReactNode {
  const light = useBaseUrl(`/img/screens/${name}-light.webp`);
  const dark = useBaseUrl(`/img/screens/${name}-dark.webp`);
  return (
    <figure className={clsx(styles.figure, className)}>
      <div className={styles.frame} style={{'--focus-x': `${-focus.x}%`, '--focus-y': `${-focus.y}%`} as CSSProperties}>
        <div className={styles.crop}>
          <ThemedImage
            className={styles.image}
            sources={{light, dark}}
            alt={alt}
            width={WIDTH}
            height={HEIGHT}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            {...(priority ? {fetchPriority: 'high' as const} : {})}
          />
        </div>
      </div>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}
