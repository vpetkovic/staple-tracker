import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Section from '@site/src/components/Section';
import Eyebrow from '@site/src/components/Eyebrow';
import Heading, {Lead} from '@site/src/components/Heading';
import Button, {ButtonRow} from '@site/src/components/Button';
import Card, {CardGrid} from '@site/src/components/Card';
import CopyCommand from '@site/src/components/CopyCommand';
import Screenshot from '@site/src/components/Screenshot';
import Terminal from '@site/src/components/Terminal';
import styles from './index.module.css';

const TITLE = 'Task tracking for coding agents';
const DESCRIPTION =
  'staple is a local-first task tracker your coding agents run on: atomic claims, a pickup queue, milestones with goals, autopilot runs and a local web UI, over one SQLite file per repository.';

// Every figure is counted from the source; how each was counted is in the pull request that set it.
const FACTS: {value: string; label: ReactNode}[] = [
  {value: '65', label: 'MCP tools, each calling the same store method as the CLI'},
  {value: '6', label: 'views in the web UI, from Tasks to Usage'},
  {value: '9', label: 'reasons an autopilot run stops, each named in its answer'},
  {value: '0', label: 'network calls until you opt in to sync or live usage checks'},
];

type FeatureProps = {
  id: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
  points: ReactNode[];
  link: {to: string; label: string};
  visual: ReactNode;
  /** `stacked` puts the copy in two columns over a full-width visual; `split` sets them side by side. */
  layout?: 'stacked' | 'split';
};

function Feature({id, eyebrow, title, children, points, link, visual, layout = 'stacked'}: FeatureProps): ReactNode {
  return (
    <div className={clsx(styles.feature, styles[layout])} id={id}>
      <div className={styles.featureHead}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Heading className={styles.featureTitle}>{title}</Heading>
      </div>
      <div className={styles.featureCopy}>
        <p className={styles.featureBody}>{children}</p>
        <ul className={styles.points}>
          {points.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
        <Link to={link.to} className={styles.more}>
          {link.label}
          <span aria-hidden="true">→</span>
        </Link>
      </div>
      <div className={styles.featureVisual}>{visual}</div>
    </div>
  );
}

// The loop from docs/getting-started.md, run against a demo workspace; the output is verbatim.
const WALKTHROUGH = [
  '# ask the queue what to take next',
  '$ staple queue next',
  'next     LUM-9 (position 1) Session expires mid-checkout on Safari',
  '# claim it: exactly one agent wins',
  '$ staple start LUM-9',
  'claimed ◐!! LUM-9     in_progress Session expires mid-checkout on Safari @claude · bug',
  '$ staple doc LUM-9 plan --put plan.md',
  'plan @ revision 1',
  '$ staple comment LUM-9 "SameSite=None on the session cookie; the 3-D Secure return keeps the session"',
  'commented.',
  '$ staple done LUM-9 -m "Fixed and covered by an e2e test on WebKit"',
  '●!! LUM-9     done        Session expires mid-checkout on Safari @claude · bug',
  '# another agent asking for a held ticket is refused, with what to do instead',
  '$ staple start LUM-6 --agent codex',
  'error(conflict): Checkout refused: status is "in_progress" (held by claude), expected one of todo, backlog, blocked. Pick a different task — do not retry.',
];

const STEPS: {command: string; tool: string; text: string}[] = [
  {command: 'queue next', tool: 'next_task', text: 'The one ticket to take, and what it stepped over.'},
  {command: 'start', tool: 'checkout_task', text: 'An atomic claim. A race has one winner.'},
  {command: 'doc', tool: 'put_document', text: 'The plan and worklog live on the ticket.'},
  {command: 'comment', tool: 'add_comment', text: 'Progress you can read in the web UI.'},
  {command: 'done', tool: 'update_task', text: 'Finishing it unblocks what waits on it.'},
];

const RUN = [
  '# one agent, one scope, a budget',
  '$ staple run start --scope LUM-3 --max-tickets 3 --until 4h',
  'run 1565a768-8228-472e-9c06-4511b90f21bf  active  codex over issue LUM-3',
  '  started 2026-09-29T07:06:45.766Z · 0/3 tickets, until 2026-09-29T11:06:45.766Z · 0 done, 0 failed, 0 open',
  '$ staple run continue',
  'take     LUM-15 Search API endpoint',
  '  LUM-15 is in scope and already held by you: finish it before taking more.',
  '# after each ticket, ask again: take, wait or stop',
  '$ staple run stop -m "enough for today"',
  'run 1565a768-8228-472e-9c06-4511b90f21bf  stopped  codex over issue LUM-3',
  '  started 2026-09-29T07:06:45.766Z · 1/3 tickets, until 2026-09-29T11:06:45.766Z · 0 done, 1 failed, 0 open',
  '    1  LUM-15    failed  stopped_by_human: enough for today',
  '  ended 2026-09-29T07:06:46.239Z: stopped_by_human by codex (enough for today)',
  '$ staple run continue',
  'stop     no_run: codex has no active or paused run (staple run start --scope <queue|ref>).',
];

export default function Home(): ReactNode {
  return (
    <Layout title={TITLE} description={DESCRIPTION}>
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <Eyebrow className={styles.heroEyebrow}>Local-first task tracker</Eyebrow>
            <Heading as="h1" align="center" className={styles.heroTitle}>
              The task tracker your coding agents run on.
            </Heading>
            <Lead align="center" className={styles.heroLead}>
              Agents claim tickets, keep their plan and worklog on them and finish them, through the CLI or MCP. You set
              the order, approve what matters and follow along in a local web UI.
            </Lead>
            <ButtonRow align="center">
              <CopyCommand command="npx staple-cli" />
              <Button to="/docs/getting-started" variant="secondary" size="lg">
                Get started
              </Button>
            </ButtonRow>
            <p className={styles.fineprint}>Node 22.5 or later. One SQLite file per repository.</p>
          </div>
          <Screenshot
            className={styles.heroShot}
            name="tasks"
            phone
            priority
            alt="The Tasks view of the staple web UI: epics for checkout, onboarding and search with their tasks, two being worked on by claude and codex, four waiting on other work and three done."
          />
        </section>

        <section className={styles.facts} aria-label="staple in numbers">
          <dl className={styles.factGrid}>
            {FACTS.map((fact) => (
              <div key={fact.value} className={styles.fact}>
                <dt className={styles.factLabel}>{fact.label}</dt>
                <dd className={styles.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <Section className={styles.features}>
          <Feature
            id="claims"
            eyebrow="Claims and dependencies"
            title="One agent per ticket. Work waits for what it needs."
            points={[
              <>
                <code>staple start</code> is an atomic checkout: in a race one agent wins, the other gets{' '}
                <code>conflict</code> and picks another ticket.
              </>,
              'A ticket with open blockers cannot be claimed, and a dependency cycle is refused on write.',
              'A claim left by an agent that died goes stale, and another agent takes it over on the record.',
            ]}
            link={{to: '/docs/epics-and-dependencies', label: 'Epics and dependencies'}}
            visual={
              <Screenshot
                name="graph"
                focus={{x: 36, y: 28}}
                alt="The Graph view: each epic is a container, and arrows run from a task to the work that waits for it."
              />
            }>
            Claims and blockers are enforced by the store, not by a prompt, so the rules hold for every agent and every
            person, whichever surface they use.
          </Feature>

          <Feature
            id="queue"
            eyebrow="Pickup queue and approval gates"
            title="Set the order once. Approve what matters."
            points={[
              'Queue a task, an epic or a milestone: containers expand to their open work, in order.',
              <>
                Advisory by default. Under <code>strict</code>, an agent that skips ahead is refused and told what to
                take.
              </>,
              <>
                A gate parks a parent on a person. Its tasks answer <code>gated</code> until you approve; a request for
                changes keeps them parked.
              </>,
            ]}
            link={{to: '/docs/queue', label: 'The pickup queue'}}
            visual={
              <Screenshot
                name="queue"
                phone
                alt="The Queue view: the pickup order, how many tasks are ready, being worked on or waiting, and the task an agent would get next."
              />
            }>
            The queue is the order agents take work in. Rank never lifts a blocker, a gate or a live claim: agents skip
            what is waiting and take the next ready ticket.
          </Feature>

          <Feature
            id="milestones"
            eyebrow="Milestones and goal mode"
            title="A date, a plan and a definition of done."
            points={[
              'Members keep their place in the tree: a milestone orders epics and tasks without moving them.',
              'Progress counts each task once, and pace compares the remaining estimates with the days left.',
              'Each goal criterion is judged met with evidence: a ticket, a document or a sentence.',
            ]}
            link={{to: '/docs/milestones', label: 'Milestones and goals'}}
            visual={
              <Screenshot
                name="milestones"
                phone
                alt="The Milestones view: the Public beta milestone with its due date, progress bar, and the epics and tasks in it, in order."
              />
            }>
            An autopilot run over a milestone is a goal run: it works until every criterion is met, and gates the
            milestone to a person so it never closes unreviewed.
          </Feature>

          <Feature
            id="runs"
            layout="split"
            eyebrow="Autopilot runs"
            title="Ticket after ticket, until a rule says stop. It never merges."
            points={[
              <>A budget per run: a ticket count, an end time, or a ceiling on a provider&apos;s rate-limit window.</>,
              <>
                <code>run drive</code> starts a fresh headless Claude, Codex or custom session per ticket; a stop hook
                keeps an interactive session working instead.
              </>,
              'The driver reads where master and main point before and after every session, and stops the run if they moved.',
            ]}
            link={{to: '/docs/runs', label: 'Autopilot runs'}}
            visual={<Terminal title="codex · run over LUM-3" lines={RUN} className={styles.featureTerminal} />}>
            After every ticket the agent asks <code>run continue</code>, and the tracker answers take, wait or stop. The
            decision is the tracker&apos;s, never the prompt&apos;s. Work lands as branches and pull requests for a
            person to merge.
          </Feature>

          <Feature
            id="web-ui"
            eyebrow="Web UI"
            title="Everything the agents know, on one screen."
            points={[
              'Tasks, Queue, Graph, Milestones, Estimates and Usage, in light and dark, on a desk or a phone.',
              "A task's detail shows who holds it, the plan and worklog, what it waits on, its activity and its time.",
              <>
                <code>staple open --hub</code> serves every workspace on the machine at once.
              </>,
            ]}
            link={{to: '/docs/web-ui', label: 'The web UI'}}
            visual={
              <Screenshot
                name="detail"
                phone
                alt="A task's detail open over the Tasks view: Saved cards at checkout, in progress and held by claude, with its properties and the latest worklog."
              />
            }>
            <code>staple open</code> serves the app from your machine, with no daemon and no account. The browser on
            this machine needs no token.
          </Feature>
        </Section>

        <Section tone="subtle">
          <div className={styles.sectionHead}>
            <Eyebrow>And underneath</Eyebrow>
            <Heading>Local first, with the rest when you want it.</Heading>
          </div>
          <CardGrid>
            <Card eyebrow="Cloud sync" title="Two machines, one workspace" to="/docs/cloud-sync">
              <p>
                Off until you connect: a workspace that was never connected makes no network call, and a test holds it
                to that. Connecting, automatic sync and backups are three separate consents, each per device. Conflicts
                are kept, never guessed.
              </p>
            </Card>
            <Card eyebrow="Budget and estimates" title="What the work really costs" to="/docs/budget-and-estimates">
              <p>
                Record an estimate when you plan; staple measures the agent&apos;s work against it, groups similar work
                and forecasts what is left, with ranges. Opt in, and it reads your Claude and Codex limits on this
                machine.
              </p>
            </Card>
            <Card eyebrow="MCP and CLI" title="One set of rules, two surfaces" to="/docs/mcp-tools">
              <p>
                Every MCP tool calls the same store method as its CLI command. Refusals are typed: <code>conflict</code>{' '}
                means pick another ticket, <code>gated</code> means a person has to act.
              </p>
            </Card>
          </CardGrid>
        </Section>

        <Section>
          <div className={styles.walk}>
            <div className={styles.walkCopy}>
              <Eyebrow>The agent loop</Eyebrow>
              <Heading>How an agent works a ticket.</Heading>
              <Lead>
                Five commands, or the five MCP tools beside them. This session ran against a copy of the demo workspace
                in the screenshots.
              </Lead>
              <ol className={styles.steps}>
                {STEPS.map((step) => (
                  <li key={step.tool} className={styles.step}>
                    <span className={styles.stepHead}>
                      <code>{step.command}</code>
                      <span className={styles.stepTool}>{step.tool}</span>
                    </span>
                    <span className={styles.stepText}>{step.text}</span>
                  </li>
                ))}
              </ol>
            </div>
            <Terminal title="claude · lumen" lines={WALKTHROUGH} className={styles.walkTerminal} />
          </div>
        </Section>

        <Section tone="subtle" className={styles.closing}>
          <Heading align="center">Give your agents a tracker.</Heading>
          <Lead align="center">
            One command sets up the repository and opens the web UI. Your agents connect over MCP.
          </Lead>
          <ButtonRow align="center">
            <CopyCommand command="npx staple-cli" />
            <Button to="/docs/getting-started" variant="secondary" size="lg">
              Get started
            </Button>
          </ButtonRow>
        </Section>
      </main>
    </Layout>
  );
}
