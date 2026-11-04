import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {FAQ} from './content';
import styles from './Faq.module.css';

function Chevron(): ReactNode {
  return (
    <svg className={styles.chevron} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

type Props = {
  className?: string;
  /** The class of the docs link under each answer, so it looks like the page's other links. */
  linkClassName?: string;
  /** What follows the link's label (the page's arrow). */
  linkMark?: ReactNode;
};

/**
 * The questions, as native `details`: they open by keyboard and without JavaScript.
 * Every answer says what the docs say and ends at the page that says it. The page
 * writes the heading. `--faq-question-font`, `--faq-question-size` and
 * `--faq-question-weight` restyle the questions.
 */
export default function Faq({className, linkClassName, linkMark}: Props): ReactNode {
  return (
    <div className={clsx(styles.faqList, className)}>
      {FAQ.map((item) => (
        <details key={item.question} className={styles.item}>
          <summary className={styles.question}>
            <span className={styles.questionText}>{item.question}</span>
            <Chevron />
          </summary>
          <div className={styles.answer}>
            <p>{item.answer}</p>
            <Link to={item.link.to} className={linkClassName}>
              {item.link.label}
              {linkMark}
            </Link>
          </div>
        </details>
      ))}
    </div>
  );
}
