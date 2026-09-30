import type {CSSProperties, ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Button from '@site/src/components/Button';
import {TrackerSync} from '@site/src/components/scenes';
import Faq from './parts/Faq';
import Install from './parts/Install';
import Steps from './parts/Steps';
import {CHAPTERS, COMPARE, DESCRIPTION, REPOSITORY, TITLE, type FeatureSpec} from './parts/content';
import styles from './Walkthrough.module.css';

// The walkthrough landing page: a centred hero in a heavy, tight sans, three steps in
// one box, the features as tiles, then one feature per section, each with one scene
// from the scene kit in a panel beside its copy, the sides alternating. The story and
// its terms follow docs/why-staple.md and the story landing page.

// The hero's decoration: the staple of the logo (a crown and two legs), nested. Each
// one is a stroke as thick as the space to the next.
const ART = {width: 760, height: 520, band: 18, pitch: 44, count: 6, radius: 46};

function stapleAt(i: number): string {
  const inset = ART.band / 2 + i * ART.pitch;
  const r = Math.max(ART.radius - i * 6, 14);
  const left = inset;
  const right = ART.width - inset;
  return `M${left} ${ART.height}V${inset + r}a${r} ${r} 0 0 1 ${r} ${-r}H${right - r}a${r} ${r} 0 0 1 ${r} ${r}V${ART.height}`;
}

/** Nested staples driven in from above, once. Decoration only. */
function Staples(): ReactNode {
  return (
    <svg className={styles.art} viewBox={`0 0 ${ART.width} ${ART.height}`} aria-hidden="true" focusable="false">
      {Array.from({length: ART.count}, (_, i) => (
        <path key={i} className={styles.staple} style={{'--i': i} as CSSProperties} d={stapleAt(i)} strokeWidth={ART.band} />
      ))}
    </svg>
  );
}

/** Two lines where there is room for them, one balanced paragraph where there is not. */
function Lines({children}: {children: [string, string]}): ReactNode {
  return (
    <>
      <span className={styles.line}>{children[0]}</span> <span className={styles.line}>{children[1]}</span>
    </>
  );
}

function Pill({children}: {children: ReactNode}): ReactNode {
  return <p className={styles.pill}>{children}</p>;
}

function Arrow(): ReactNode {
  return (
    <span className={styles.arrow} aria-hidden="true">
      →
    </span>
  );
}

type IconName = 'ticket' | 'claim' | 'queue' | 'gate' | 'local' | 'surfaces';

// 24 px line icons, drawn for this page.
function Icon({name}: {name: IconName}): ReactNode {
  const shapes: Record<IconName, ReactNode> = {
    ticket: (
      <>
        <rect x="4.75" y="3.75" width="14.5" height="16.5" rx="3" />
        <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
      </>
    ),
    claim: (
      <>
        <circle cx="12" cy="12" r="8.25" />
        <path d="M12 12V6.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
      </>
    ),
    queue: (
      <>
        <path d="M10 6.5h9.25M10 12h9.25M10 17.5h9.25" />
        <path d="M4.75 5.5 6 4.75V8.5M4.75 11.25h2v1.4l-2 1.85h2.1M4.75 16.25h2v3.5h-2M5.6 18h1.15" />
      </>
    ),
    gate: (
      <>
        <path d="M12 3.75 5 6.5v5.25c0 4 2.8 7.1 7 8.5 4.2-1.4 7-4.5 7-8.5V6.5z" />
        <path d="m9 12.2 2.1 2.1L15.2 10" />
      </>
    ),
    local: (
      <>
        <ellipse cx="12" cy="6.75" rx="7.25" ry="3" />
        <path d="M4.75 6.75v10.5c0 1.66 3.25 3 7.25 3s7.25-1.34 7.25-3V6.75M4.75 12c0 1.66 3.25 3 7.25 3s7.25-1.34 7.25-3" />
      </>
    ),
    surfaces: (
      <>
        <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="3" />
        <path d="m7.75 10 2.5 2.25-2.5 2.25M12.75 14.5h3.5" />
      </>
    ),
  };
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      {shapes[name]}
    </svg>
  );
}

const TILES: {icon: IconName; title: string; text: string}[] = [
  {icon: 'ticket', title: 'Tickets with context', text: 'The plan, the worklog and the comments live on the ticket, next to the tickets it waits on.'},
  {icon: 'claim', title: 'Atomic claims', text: 'One agent per ticket. A second agent asking for a held ticket is refused and told to pick another.'},
  {icon: 'queue', title: 'Pickup queue', text: 'The order agents take work in. Rank never lifts a blocker or a live claim.'},
  {icon: 'gate', title: 'Approval gates', text: 'Park an epic on a person. The tickets under it wait until you approve.'},
  {icon: 'local', title: 'Local-first', text: 'One SQLite file per repository. No account, no server, and it works offline.'},
  {icon: 'surfaces', title: 'CLI, MCP and web UI', text: '65 MCP tools, each calling the same store method as the CLI, and a web UI with 6 views.'},
];

/** The logo's staple, as the mark of a point. */
function Mark(): ReactNode {
  return (
    <svg className={styles.mark} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M6 11.5H3.5v-7h9v7H10" />
    </svg>
  );
}

/** One feature: a pill, a two-line headline, its copy, and one scene in a panel. */
function Feature({spec, flip}: {spec: FeatureSpec; flip: boolean}): ReactNode {
  return (
    <article className={clsx(styles.feature, flip && styles.flip)} aria-labelledby={`wt-${spec.id}`}>
      <div className={styles.featureHead}>
        <Pill>{spec.pill}</Pill>
        <h3 id={`wt-${spec.id}`} className={styles.featureTitle}>
          <Lines>{spec.title}</Lines>
        </h3>
      </div>
      <div className={styles.panel}>
        <div className={styles.stage}>{spec.scene}</div>
      </div>
      <div className={styles.featureCopy}>
        {spec.body && <p className={styles.body}>{spec.body}</p>}
        {spec.points && (
          <ul className={styles.points}>
            {spec.points.map((point, i) => (
              <li key={i}>
                <Mark />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        )}
        <Link to={spec.link.to} className={styles.more}>
          {spec.link.label}
          <Arrow />
        </Link>
      </div>
    </article>
  );
}

// How many features come before each chapter, so the sides alternate down the whole page.
const BEFORE = CHAPTERS.map((_, c) => CHAPTERS.slice(0, c).reduce((sum, chapter) => sum + chapter.features.length, 0));

export default function Walkthrough(): ReactNode {
  return (
    <Layout title={TITLE} description={DESCRIPTION}>
      <main className={styles.page}>
        <section className={styles.hero}>
          <Staples />
          <div className={styles.heroCopy}>
            <h1 className={styles.heroTitle}>
              <Lines>{['Plans your agents', 'can finish.']}</Lines>
            </h1>
            <p className={styles.heroLead}>
              staple turns an implementation plan into tickets that carry the whole context. Agents work them one by
              one, and a new session picks up where a dead one stopped.
            </p>
            <div className={styles.heroActions}>
              <Button to="/docs/getting-started" size="lg" className={styles.cta}>
                Get started
              </Button>
              <Link to="/docs/why-staple" className={styles.quiet}>
                or read why staple exists
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.stepsBand} aria-labelledby="wt-steps">
          <div className={styles.container}>
            <h2 id="wt-steps" className={styles.hidden}>
              From plan to done in three steps
            </h2>
            <Steps className={styles.steps} />
          </div>
        </section>

        <section className={styles.overview} aria-labelledby="wt-features">
          <div className={styles.container}>
            <Pill>Features</Pill>
            <h2 id="wt-features" className={styles.title}>
              <Lines>{['Everything a plan needs', 'to get finished.']}</Lines>
            </h2>
            <ul className={styles.tiles}>
              {TILES.map((tile) => (
                <li key={tile.title} className={styles.tile}>
                  <Icon name={tile.icon} />
                  <h3 className={styles.tileTitle}>{tile.title}</h3>
                  <p className={styles.tileText}>{tile.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {CHAPTERS.map((chapter, c) => (
          <section key={chapter.id} id={chapter.id} className={clsx(styles.chapter, c % 2 === 1 && styles.tinted)} aria-labelledby={`wt-chapter-${chapter.id}`}>
            <div className={styles.container}>
              <h2 id={`wt-chapter-${chapter.id}`} className={styles.chapterHead}>
                <span className={styles.chapterNumber} aria-hidden="true">
                  {String(c + 1).padStart(2, '0')}
                </span>
                <span className={styles.chapterTitle}>{chapter.title}</span>
                <span className={styles.chapterRule} aria-hidden="true" />
              </h2>
              {chapter.features.map((spec, i) => (
                <Feature key={spec.id} spec={spec} flip={(BEFORE[c] + i) % 2 === 1} />
              ))}
            </div>
          </section>
        ))}

        <section className={clsx(styles.alongside, styles.tinted)} aria-labelledby="wt-alongside">
          <div className={styles.container}>
            <div className={styles.centerHead}>
              <Pill>Next to Linear, GitHub, ClickUp</Pill>
              <h2 id="wt-alongside" className={styles.title}>
                <Lines>{['Keep your team’s board.', 'Give agents their own.']}</Lines>
              </h2>
              <p className={styles.lead}>
                staple does not replace your team’s tracker. It is the execution layer: the place where agents do the
                work, locally, ticket by ticket. Your team’s board stays where people plan, discuss and report.
              </p>
            </div>
            <div className={clsx(styles.panel, styles.panelWide)}>
              <div className={styles.stage}>
                <TrackerSync fade="none" />
              </div>
            </div>
            <p className={styles.plannedNote}>
              Integrations that keep the two in sync, with GitHub Issues, ClickUp and Linear, are planned, not shipped.
              Today staple does not read from or write to any of them: use it alongside them and carry items across
              yourself.
            </p>
            <dl className={styles.compare}>
              {COMPARE.map((row) => (
                <div key={row.term} className={styles.compareCell}>
                  <dt className={styles.compareTerm}>{row.term}</dt>
                  <dd className={styles.compareValue}>
                    <span className={styles.compareWho}>Your team’s tracker</span>
                    {row.tracker}
                  </dd>
                  <dd className={clsx(styles.compareValue, styles.compareStaple)}>
                    <span className={styles.compareWho}>staple</span>
                    {row.staple}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className={styles.faq} aria-labelledby="wt-faq">
          <div className={clsx(styles.container, styles.faqGrid)}>
            <div className={styles.faqHead}>
              <Pill>FAQ</Pill>
              <h2 id="wt-faq" className={styles.title}>
                <Lines>{['Questions,', 'answered.']}</Lines>
              </h2>
              <p className={styles.lead}>
                The short answers. Each one ends at the page of the docs that has the long one.
              </p>
            </div>
            <Faq linkClassName={styles.more} linkMark={<Arrow />} />
          </div>
        </section>

        <section className={clsx(styles.closing, styles.tinted)} aria-labelledby="wt-start">
          <div className={clsx(styles.container, styles.centerHead)}>
            <Pill>Get started</Pill>
            <h2 id="wt-start" className={styles.title}>
              <Lines>{['Move the plan', 'out of Markdown.']}</Lines>
            </h2>
            <Install />
            <p className={styles.closingText}>
              One command sets up the repository and opens the web UI. Your agents connect over MCP. Node 22.5 or
              later, one SQLite file per repository.
            </p>
            <div className={styles.closingActions}>
              <Button to="/docs/getting-started" size="lg" className={styles.cta}>
                Get started
              </Button>
              <Button to={REPOSITORY} variant="secondary" size="lg" className={styles.cta}>
                View on GitHub
              </Button>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
