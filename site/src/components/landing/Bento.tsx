import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Button, {ButtonRow} from '@site/src/components/Button';
import CopyCommand from '@site/src/components/CopyCommand';
import {ApprovalGate, AutopilotRun, Budget, Handoff, MilestoneGoal, OneStore, PlanToTickets, QueuePickup, TicketContext, TrackerSync} from '@site/src/components/scenes';
import CompareTable, {Planned} from './parts/CompareTable';
import PlanFolder from './parts/PlanFolder';
import SerifFont from './parts/SerifFont';
import TicketChips, {PauseButton, fromBottom, useDrift, type ChipSpec} from './parts/TicketChips';
import {DESCRIPTION, FACTS, TITLE} from './parts/content';
import styles from './Bento.module.css';

// The bento landing page: serif headlines, a dashed drafting grid, ticket chips
// drifting through the hero, and a dense grid of cells that each show one feature
// with one scene from the scene kit, cut by the cell. The story and its terms follow
// docs/why-staple.md and the story landing page.

// The word that changes in the headline. The first one is the headline a screen
// reader, a crawler and a visitor who asked for reduced motion get.
const WORDS = ['finish', 'resume', 'survive'];
const WORD_MS = 3200;

// Tickets of the docs' example epic (Multi-tenancy, prefix APP), as the web UI would
// list them, and where each sits: around the copy from 1280 px, and below that in a band
// above the copy and one below it, measured from the hero's edges.
const CHIPS: ChipSpec[] = [
  {id: 'APP-2', title: 'Tenant id on every table', status: 'active', depth: 1, at: ['16%', '21%'], tablet: ['25%', '4.5rem'], phone: ['38%', '2.5rem'], drift: [46, -18], seconds: 19, leaves: 'late'},
  {id: 'APP-7', title: 'Backfill tenant_id on invoices', status: 'done', depth: 2, at: ['9.5%', '35%'], drift: [30, 14], seconds: 23, leaves: 'early'},
  {id: 'APP-9', title: 'Audit log per tenant', status: 'backlog', depth: 3, at: ['10%', '57%'], tablet: ['13%', '8rem'], drift: [-20, -12], seconds: 27, leaves: 'middle'},
  {id: 'APP-5', title: 'Tenant-aware rate limits', status: 'ready', depth: 1, at: ['20%', '78%'], tablet: ['24%', fromBottom(6.75)], phone: ['38%', fromBottom(7.75)], drift: [-40, -16], seconds: 21, leaves: 'middle'},
  {id: 'APP-6', title: 'Migrate sessions to tenant scope', status: 'review', depth: 3, at: ['49%', '10%'], drift: [22, 8], seconds: 25, leaves: 'early'},
  {id: 'APP-12', title: 'Rotate API keys per tenant', status: 'review', depth: 2, at: ['86%', '14%'], tablet: ['76%', '2.75rem'], drift: [-28, 12], seconds: 24, leaves: 'late'},
  {id: 'APP-3', title: 'Scope queries by tenant', status: 'backlog', depth: 1, at: ['89.5%', '33%'], tablet: ['71%', '7rem'], phone: ['60%', '5.25rem'], drift: [-44, 14], seconds: 22, leaves: 'early'},
  {id: 'APP-4', title: 'Tenant-aware billing', status: 'blocked', depth: 2, at: ['87.5%', '55%'], drift: [-24, -14], seconds: 26, leaves: 'middle'},
  {id: 'APP-8', title: 'Tenant switcher in the admin', status: 'gated', depth: 1, at: ['81%', '77%'], tablet: ['64%', fromBottom(4.5)], phone: ['56%', fromBottom(5)], drift: [38, -20], seconds: 20, leaves: 'late'},
  {id: 'APP-11', title: 'Index tenant_id on payments', status: 'done', depth: 3, at: ['61%', '91%'], drift: [-26, -8], seconds: 28, leaves: 'early'},
  {id: 'APP-10', title: 'Remove the global admin query', status: 'backlog', depth: 3, at: ['34%', '90%'], tablet: ['46%', fromBottom(8.5)], drift: [24, -10], seconds: 25, leaves: 'late'},
];

function Hero(): ReactNode {
  // `off`: nothing moves (the server's HTML, no JavaScript, reduced motion). `on`: the
  // chips drift and the word changes. `held`: stopped where it is.
  const {ref, allowed, motion, paused, togglePaused} = useDrift();
  const [word, setWord] = useState({now: 0, before: -1});
  const words = useRef<(HTMLSpanElement | null)[]>([]);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    if (motion === 'off') setWord({now: 0, before: -1});
    if (motion !== 'on') return undefined;
    const timer = window.setInterval(() => setWord(({now}) => ({now: (now + 1) % WORDS.length, before: now})), WORD_MS);
    return () => window.clearInterval(timer);
  }, [motion]);

  // The line is laid out around the first word, so the headline is centred before any
  // script runs. A longer or shorter word moves the line by half the difference, as a
  // transform, to stay centred: nothing is laid out again.
  useEffect(() => {
    const measure = () => {
      const first = words.current[0]?.getBoundingClientRect().width ?? 0;
      const now = words.current[word.now]?.getBoundingClientRect().width ?? first;
      setShift(Math.round((first - now) / 2));
    };
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => window.removeEventListener('resize', measure);
  }, [word.now]);

  return (
    <section ref={ref} className={styles.hero}>
      <TicketChips chips={CHIPS} motion={motion} />
      <div className={styles.heroCopy}>
        {/* The headline is "Plans that finish" in the HTML and to assistive technology.
            The other words exist only while motion is on, and only to the eye. */}
        <h1 className={styles.heroTitle}>
          <span className={styles.heroWords} style={{'--shift': `${shift}px`} as CSSProperties}>
            Plans that{' '}
            <span className={styles.rotor}>
              {WORDS.slice(0, allowed ? WORDS.length : 1).map((text, i) => (
                <em key={text} aria-hidden={i > 0 || undefined} className={clsx(styles.word, i === word.now && styles.wordNow, i === word.before && styles.wordBefore)}>
                  <span
                    ref={(node) => {
                      words.current[i] = node;
                    }}>
                    {text}
                  </span>
                </em>
              ))}
            </span>
          </span>
        </h1>
        <p className={styles.heroLead}>
          staple turns a plan into an epic and tickets that carry the whole context, so your agents always know what
          comes next, and a new session picks up where a dead one stopped.
        </p>
        <ButtonRow align="center">
          <CopyCommand command="npx staple-cli" />
          <Button to="/docs" variant="secondary" size="lg">
            Read the docs
          </Button>
        </ButtonRow>
      </div>
      {allowed && <PauseButton paused={paused} onToggle={togglePaused} className={styles.pause} />}
    </section>
  );
}

function Arrow(): ReactNode {
  return (
    <span className={styles.arrow} aria-hidden="true">
      →
    </span>
  );
}

type CellProps = {
  title: ReactNode;
  children: ReactNode;
  scene: ReactNode;
  /** How much of the scene's lower edge the cell cuts off. */
  cut?: 'edge' | 'row';
  /** Copy beside the scene instead of above it, where the cell is wide enough. */
  beside?: boolean;
};

/** One feature: a serif title, two lines, and a scene that the cell cuts at its lower edge. */
function Cell({title, children, scene, cut = 'edge', beside}: CellProps): ReactNode {
  return (
    <article className={clsx(styles.cell, beside && styles.cellBeside)}>
      <div className={styles.cellCopy}>
        <h3 className={clsx(styles.cellTitle, styles.tick)}>{title}</h3>
        <p className={styles.cellText}>{children}</p>
      </div>
      <div className={clsx(styles.fragment, cut === 'row' && styles.fragmentRow)}>{scene}</div>
    </article>
  );
}

export default function Bento(): ReactNode {
  return (
    <Layout title={TITLE} description={DESCRIPTION}>
      {/* The serif face belongs to this page and the blend page: fetched early here, never on another page. */}
      <SerifFont />
      <main className={styles.page}>
        <div className={styles.top}>
          <Hero />
          <p className={styles.statement}>
            staple is a local-first task tracker for coding agents: one SQLite file per repository, next to your
            team’s tracker.
          </p>
        </div>

        <div className={styles.sheet}>
          <section className={styles.band} aria-labelledby="bento-problem">
            <div className={styles.lede}>
              <p className={styles.eyebrow}>The problem</p>
              <h2 id="bento-problem" className={clsx(styles.title, styles.tick)}>
                A folder of plans is <em>not</em> a backlog.
              </h2>
            </div>
            <div className={styles.figure}>
              <div className={styles.fragment}>
                <PlanFolder />
              </div>
            </div>
            <div className={styles.prose}>
              <p>
                Every brainstorm and implementation plan becomes a Markdown file, and the files point at each other.
                Checkboxes drift because an agent forgot to tick them, and work found halfway through goes into
                whichever file was open.
              </p>
              <p>
                Then a session ends in the middle of a feature: the five-hour limit, the weekly quota, a closed
                terminal. The next one rereads the files, guesses where things stand, and asks you.
              </p>
            </div>
          </section>

          <section className={styles.band} aria-labelledby="bento-answer">
            <div className={styles.lede}>
              <p className={styles.eyebrow}>What staple does</p>
              <h2 id="bento-answer" className={clsx(styles.title, styles.tick)}>
                Tickets that carry the <em>whole</em> context.
              </h2>
            </div>
            <div className={styles.figure}>
              <div className={styles.fragment}>
                <TicketContext fade="none" />
              </div>
            </div>
            <div className={styles.prose}>
              <p>
                The real work items move out of Markdown into a tracker built for agents: structured, queryable and
                durable, on your machine.
              </p>
              <p>
                The plan is a document on the ticket, next to the worklog, the comments and the tickets it waits on. An
                agent that opens a ticket finds everything it needs there.
              </p>
              <Link to="/docs/why-staple" className={styles.more}>
                Why staple
                <Arrow />
              </Link>
            </div>
          </section>

          <section className={clsx(styles.band, styles.bento)} aria-labelledby="bento-flow">
            <div className={clsx(styles.lede, styles.idea)}>
              <div className={styles.ideaInner}>
                <div>
                  <p className={styles.eyebrow}>From plan to done</p>
                  <h2 id="bento-flow" className={clsx(styles.title, styles.tick)}>
                    A plan becomes an epic. Agents work it <em>ticket by ticket</em>.
                  </h2>
                </div>
                <div className={styles.ideaBody}>
                  <p>
                    Brainstorm and write the implementation plan as you do today. Each step becomes a ticket under the
                    epic, with its dependencies, and the work outlives any one session.
                  </p>
                  <p>
                    Agents take the next ready ticket on their own. You set the order, choose what needs your sign-off,
                    and see at any moment what is done, what is next and who is on it.
                  </p>
                  <Link to="/docs/working-a-ticket" className={styles.more}>
                    How an agent works a ticket
                    <Arrow />
                  </Link>
                </div>
              </div>
            </div>

            <div className={styles.stack}>
              <Cell title="Plans become tickets" scene={<PlanToTickets fade="none" />}>
                Each step of the plan becomes a ticket under the epic, with what it waits on. The plan is stored on the
                epic.
              </Cell>
              <Cell title="Work survives the session" scene={<Handoff fade="none" />} beside>
                An agent stores a worklog after each step. When its session dies, another takes the ticket over, on
                the record, and reads where to continue.
              </Cell>
              <Cell title="A date and a definition of done" scene={<MilestoneGoal fade="none" />}>
                A milestone puts a date on a set of epics and tasks. Each goal criterion is judged met with evidence.
              </Cell>
              <Cell title="One store, three ways in" scene={<OneStore fade="none" />}>
                The CLI, the MCP tools and the web UI call the same store, so a rule holds for every agent and every
                person.
              </Cell>
            </div>

            <div className={styles.stack}>
              <Cell title="Set the order once" scene={<QueuePickup fade="none" />} cut="row">
                The pickup queue is the order agents take work in. Rank never lifts a blocker or a live claim.
              </Cell>
              <Cell title="You decide. You don’t babysit." scene={<ApprovalGate fade="none" />}>
                An approval gate parks a parent, such as an epic, on a person: the tickets under it wait until you
                approve.
              </Cell>
              <Cell title="Ticket after ticket, then stop" scene={<AutopilotRun fade="none" />}>
                An autopilot run has a budget: a ticket count, an end time or a rate-limit ceiling. Work lands as
                branches and pull requests for a person to merge.
              </Cell>
              <Cell title="Know what the work costs" scene={<Budget fade="none" />}>
                Estimate a ticket when you plan it; staple measures the agent work against it, and warns when your pace
                eats into the reserve of a usage limit.
              </Cell>
            </div>
          </section>

          <section className={clsx(styles.band, styles.alongside)} aria-labelledby="bento-alongside">
            <div className={styles.lede}>
              <p className={styles.eyebrow}>Next to Linear, GitHub and ClickUp</p>
              <h2 id="bento-alongside" className={clsx(styles.title, styles.tick)}>
                Keep your team’s board. Give agents <em>their own</em>.
              </h2>
            </div>
            <div className={clsx(styles.figure, styles.figureWide)}>
              <div className={styles.fragment}>
                <TrackerSync fade="none" />
              </div>
            </div>
            <div className={clsx(styles.prose, styles.alongsideCopy)}>
              <p>
                staple does not replace your team’s tracker. It is the execution layer: the place where agents do the
                work, locally, ticket by ticket. Your team’s board stays where people plan, discuss and report.
              </p>
              <p className={styles.plannedNote}>
                <Planned />
                Integrations that keep the two in sync, with GitHub Issues, ClickUp and Linear, are planned, not
                shipped. Today staple does not read from or write to any of them: use it alongside them and carry
                items across yourself.
              </p>
            </div>
            <div className={styles.compare}>
              <CompareTable />
            </div>
          </section>

          <section className={clsx(styles.band, styles.underneath)} aria-labelledby="bento-underneath">
            <div className={styles.lede}>
              <div className={styles.ledeSplit}>
                <div>
                  <p className={styles.eyebrow}>Underneath</p>
                  <h2 id="bento-underneath" className={clsx(styles.title, styles.tick)}>
                    Small enough to carry. <em>Strict</em> where it counts.
                  </h2>
                </div>
                <p className={styles.ledeText}>
                  The rules are enforced by the store, not by a prompt, so they hold for every agent and every person.
                </p>
              </div>
            </div>
            <dl className={styles.facts}>
              {FACTS.map((fact) => (
                <div key={fact.value} className={styles.fact}>
                  <dt className={styles.factLabel}>{fact.label}</dt>
                  <dd className={styles.factValue}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className={clsx(styles.band, styles.closing)} aria-labelledby="bento-install">
            <h2 id="bento-install" className={styles.closingTitle}>
              Move the plan <em>out of</em> Markdown.
            </h2>
            <p className={styles.closingLead}>One command sets up the repository and opens the web UI. Your agents connect over MCP.</p>
            <ButtonRow align="center">
              <CopyCommand command="npx staple-cli" />
              <Button to="/docs/getting-started" variant="secondary" size="lg">
                Get started
              </Button>
            </ButtonRow>
            <p className={styles.fineprint}>Node 22.5 or later. One SQLite file per repository.</p>
          </section>
        </div>
      </main>
    </Layout>
  );
}
