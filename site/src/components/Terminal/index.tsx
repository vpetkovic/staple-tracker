import type {ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Props = {
  /**
   * The session, one entry per line. `$ ` starts a command (the prompt is drawn
   * and not selectable), `# ` starts a comment, anything else is output.
   */
  lines: string[];
  /** The window title. */
  title?: string;
  className?: string;
};

function Line({line}: {line: string}): ReactNode {
  if (line.startsWith('$ ')) {
    return (
      <span className={styles.command}>
        <span className={styles.prompt} aria-hidden="true">
          $
        </span>
        {line.slice(2)}
      </span>
    );
  }
  if (line.startsWith('# ')) {
    return <span className={styles.comment}>{line}</span>;
  }
  return <span className={styles.output}>{line}</span>;
}

// A terminal window for a short command session on marketing pages.
// Docs pages keep ordinary fenced code blocks.
export default function Terminal({lines, title = 'Terminal', className}: Props): ReactNode {
  return (
    <figure className={clsx(styles.terminal, className)}>
      <figcaption className={styles.bar}>
        <span className={styles.dots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className={styles.title}>{title}</span>
      </figcaption>
      <pre className={styles.body} tabIndex={0}>
        <code>
          {lines.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </code>
      </pre>
    </figure>
  );
}
