import {useEffect, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type Props = {
  /** The command, shown after a `$` prompt and copied without it. */
  command: string;
  /** `primary` for the one main action in a view, `secondary` for the rest. */
  variant?: 'primary' | 'secondary';
  className?: string;
};

function CopyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M3 8.5l3 3 7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A shell command with a copy button: the call to action when the action is a command.
export default function CopyCommand({command, variant = 'primary', className}: Props): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={clsx(styles.command, styles[variant], className)}>
      <code className={styles.text}>
        <span className={styles.prompt} aria-hidden="true">
          $
        </span>
        {command}
      </code>
      <button type="button" className={styles.copy} onClick={copy} aria-label={`Copy ${command}`}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span className={styles.status} role="status">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </div>
  );
}
