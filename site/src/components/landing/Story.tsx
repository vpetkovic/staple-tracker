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
import PlanFlow, {FlowEvents, FlowFile, FlowTickets} from '@site/src/components/PlanFlow';
import styles from './Story.module.css';

// The story-led landing page: the problem, what staple does about it, how a plan
// becomes work, the person in the loop, and where staple sits next to a team's
// tracker. The story and its terms follow docs/why-staple.md.

const TITLE = 'Implementation plans your agents can finish';
const DESCRIPTION =
  'staple turns an implementation plan into an epic and tickets that carry their full context, so coding agents work through it, resume after a session dies and file new work under the same epic. Local-first, next to your team’s tracker.';

// The folder from docs/why-staple.md: plans that point at each other.
const PLAN_FILES: {name: string; note?: string}[] = [
  {name: 'brainstorm-rate-limits.md'},
  {name: 'plan-auth-refactor.md', note: 'blocked until tenant ids land, see plan-multi-tenancy.md'},
  {name: 'plan-multi-tenancy.md', note: 'step 4 depends on plan-auth-refactor.md, step 2'},
  {name: 'plan-multi-tenancy-v2.md', note: 'replaces parts of plan-multi-tenancy.md'},
  {name: 'plan-tenant-billing.md'},
];

// A session against a scratch workspace, run for this page: claude claimed APP-2,
// stored a worklog and went silent; half an hour later codex ran these. Commands and
// output are verbatim, with four changes: the workspace's own prefix is shown as APP
// (the docs' example prefix), the `# ` lines above commands are annotations, `show`
// is cut to its first three lines, and the blank line after the worklog header is
// dropped. The header itself (`# worklog @ r1 …`) is real output, which the Terminal
// draws like a comment.
const RESUME = [
  '# claude went quiet mid-ticket; the ticket says so',
  '$ staple show APP-2',
  '◇ APP-2 · Tenant id on every table',
  'status in_progress (v1) · kind task · priority medium · @claude · held by claude',
  'claim  held 31m · silent 31m (last activity 2026-09-29T13:11:53Z)',
  '# take the claim over, on the record',
  '$ staple start APP-2 --steal-if-stale 30m',
  'stole ◐  APP-2     in_progress Tenant id on every table @codex (was claude, silent 31m)',
  '$ staple doc APP-2 worklog',
  '# worklog @ r1 (2026-09-29T13:11)',
  'Done: tenant_id column on 9 of 14 tables, backfill script',
  'Next: invoices, payments, audit_log, sessions, api_keys',
  'Files touched: db/migrations/0042_tenant_id.sql, scripts/backfill-tenant.ts',
  '# work the plan did not foresee goes under the same epic',
  '$ staple new "Tenant-aware rate limits" --parent APP-1',
  '◌  APP-5     backlog     Tenant-aware rate limits',
  '$ staple done APP-2 -m "tenant_id on all 14 tables, backfilled"',
  '●  APP-2     done        Tenant id on every table @codex',
  '$ staple inbox',
  'READY (pickup order):',
  '  ◌  APP-1     backlog     Multi-tenancy · epic',
  '  ◌  APP-3     backlog     Scope queries by tenant',
  '  ◌  APP-5     backlog     Tenant-aware rate limits',
  'BLOCKED:',
  '  ◌  APP-4     backlog     Tenant-aware billing  [waiting on APP-3]',
];

// Every figure is counted from the source, as on the classic landing page.
const FACTS: {value: string; label: ReactNode}[] = [
  {value: '1', label: 'SQLite file per repository: no account, no server to run'},
  {value: '65', label: 'MCP tools, each calling the same store method as the CLI'},
  {value: '6', label: 'views in the web UI, from Tasks to Usage'},
  {value: '0', label: 'network calls until you opt in to sync or live usage checks'},
];

function PlanFolder(): ReactNode {
  return (
    <figure className={styles.folder}>
      <figcaption className={styles.folderBar}>
        <span className={styles.folderPath}>docs/plans/</span>
        <span className={styles.folderMeta}>{PLAN_FILES.length} files</span>
      </figcaption>
      <ul className={styles.folderList}>
        {PLAN_FILES.map((file) => (
          <li key={file.name} className={styles.folderRow}>
            <svg className={styles.fileIcon} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 1.75h5.25L12.5 5v9.25h-8.5z M9 1.75V5.25h3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
            </svg>
            <span className={styles.folderName}>{file.name}</span>
            {file.note && <span className={styles.folderNote}>“{file.note}”</span>}
          </li>
        ))}
      </ul>
      <p className={styles.folderEnd}>
        <span className={styles.folderEndMark} aria-hidden="true" />
        The session ends mid-feature: the usage limit is reached. The next one starts cold.
      </p>
    </figure>
  );
}

// Where staple sits next to a team's tracker, and the integrations that are planned.
function Alongside(): ReactNode {
  const rows = (items: [string, string][]) => (
    <dl className={styles.sideList}>
      {items.map(([term, value]) => (
        <div key={term} className={styles.sideRow}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <div className={styles.alongside}>
      <div className={styles.side}>
        <p className={styles.sideEyebrow}>Your team’s tracker</p>
        <p className={styles.sideTitle}>Linear, GitHub or ClickUp</p>
        {rows([
          ['Used by', 'People planning and reporting'],
          ['Runs', 'Hosted, over the network'],
          ['Holds', 'Features, priorities, discussion'],
        ])}
      </div>
      <div className={styles.bridge}>
        <span className={styles.bridgeLine} aria-hidden="true" />
        <span className={styles.bridgeLabel}>
          Sync <span className={styles.planned}>Planned</span>
        </span>
        <span className={styles.bridgeLine} aria-hidden="true" />
      </div>
      <div className={clsx(styles.side, styles.sideStaple)}>
        <p className={styles.sideEyebrow}>The execution layer</p>
        <p className={styles.sideTitle}>staple</p>
        {rows([
          ['Used by', 'Agents doing the work, and you watching it'],
          ['Runs', 'Locally, one file per repository'],
          ['Holds', 'Epics, tickets, plans, worklogs, claims'],
        ])}
      </div>
    </div>
  );
}

export default function Story(): ReactNode {
  return (
    <Layout title={TITLE} description={DESCRIPTION}>
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <Eyebrow className={styles.heroEyebrow}>Local-first task tracker</Eyebrow>
            <Heading as="h1" align="center" className={styles.heroTitle}>
              Give your agents work they can trust.
            </Heading>
            <Lead align="center" className={styles.heroLead}>
              Stop running features from a folder of Markdown plans. staple turns a plan into an epic and tickets that
              carry the whole context, so agents always know what comes next, and a new session picks up where a dead
              one stopped.
            </Lead>
            <ButtonRow align="center">
              <CopyCommand command="npx staple-cli" />
              <Button to="/docs/getting-started" variant="secondary" size="lg">
                Get started
              </Button>
            </ButtonRow>
            <p className={styles.fineprint}>Node 22.5 or later. One SQLite file per repository.</p>
          </div>
        </section>

        <Section id="problem" className={styles.problem}>
          <div className={styles.split}>
            <div className={styles.splitCopy}>
              <Eyebrow>The problem</Eyebrow>
              <Heading>A folder of plans is not a backlog.</Heading>
              <p className={styles.body}>
                Every brainstorm and implementation plan becomes a Markdown file, and the files point at each other. The
                more detailed the plans get, the harder it is to see a milestone, know what comes next, or tell which
                steps are done. Checkboxes drift because an agent forgot to tick them, and work found halfway through
                goes into whichever file was open.
              </p>
              <p className={styles.body}>
                Then a session ends in the middle of a feature: the five-hour limit, the weekly quota, a closed
                terminal. The plan and the harness’s task list lived in that session. The next one rereads the files,
                guesses where things stand, and asks you.
              </p>
            </div>
            <div className={styles.splitVisual}>
              <PlanFolder />
            </div>
          </div>
        </Section>

        <Section tone="subtle" id="answer">
          <div className={styles.sectionHead}>
            <Eyebrow>What staple does</Eyebrow>
            <Heading>Tickets that carry the whole context.</Heading>
            <Lead>
              The real work items move out of Markdown into a tracker built for agents: structured, queryable and
              durable, on your machine.
            </Lead>
          </div>
          <CardGrid columns={2}>
            <Card eyebrow="First-class tickets" title="Everything an agent needs, on the ticket" to="/docs/working-a-ticket">
              <p>
                The plan is a document on the ticket, next to the worklog, the comments and the tickets it waits on. An
                agent that opens a ticket finds everything it needs there.
              </p>
            </Card>
            <Card eyebrow="Handoff" title="Work survives the session" to="/docs/handoff">
              <p>
                An agent stores a short Done, Next and Files touched worklog after each step. When its session dies,
                another session, or another agent in a different harness, takes the ticket over and reads where to
                continue.
              </p>
            </Card>
            <Card eyebrow="Claims" title="One agent per ticket" to="/docs/epics-and-dependencies">
              <p>
                The claim is atomic: a second agent asking for a held ticket is refused and told to pick another. A
                ticket that waits on unfinished work cannot be claimed at all.
              </p>
            </Card>
            <Card eyebrow="Local-first" title="No network between an agent and its next ticket" to="/docs/getting-started">
              <p>
                Each repository keeps its tickets in one SQLite file. No account, no server, no rate limit, and it
                works offline. Cloud sync between two machines is there when you opt in.
              </p>
            </Card>
          </CardGrid>
        </Section>

        <Section id="plan-to-work">
          <div className={styles.sectionHead}>
            <Eyebrow>From plan to done</Eyebrow>
            <Heading>A plan becomes an epic. Agents work it ticket by ticket.</Heading>
            <Lead>
              Brainstorm and write the implementation plan as you do today. Then the plan becomes tracked work that
              outlives any one session.
            </Lead>
          </div>
          <PlanFlow
            label="From an implementation plan to finished work"
            steps={[
              {
                title: 'Write the plan',
                text: 'The implementation plan you and your agent agreed on, with its steps and what depends on what.',
                visual: (
                  <FlowFile
                    name="plan.md"
                    meta="revision 1"
                    lines={[
                      '# Multi-tenancy',
                      '',
                      'Every query is scoped to one tenant.',
                      '',
                      '## Steps',
                      '1. Tenant id on every table',
                      '2. Scope queries by tenant (after 1)',
                      '3. Tenant-aware billing (after 2)',
                    ]}
                  />
                ),
              },
              {
                title: 'Break it into an epic and tickets',
                text: 'Each step becomes a ticket under the epic, with its dependencies. The plan is stored on the epic.',
                visual: (
                  <FlowTickets
                    title="staple tree"
                    meta="APP-1"
                    tickets={[
                      {id: 'APP-1', title: 'Multi-tenancy', state: 'active', epic: true, note: 'epic · plan.md'},
                      {id: 'APP-2', title: 'Tenant id on every table', state: 'active', note: 'held by claude'},
                      {id: 'APP-3', title: 'Scope queries by tenant', state: 'waiting', note: 'waits on APP-2'},
                      {id: 'APP-4', title: 'Tenant-aware billing', state: 'waiting', note: 'waits on APP-3'},
                      {id: 'APP-5', title: 'Tenant-aware rate limits', state: 'ready', note: 'filed mid-flight', added: true},
                    ]}
                  />
                ),
              },
              {
                title: 'Agents work, resume and extend it',
                text: 'An agent claims a ticket and keeps a worklog. When its session dies, the next one takes over from “Next”.',
                visual: (
                  <FlowEvents
                    title="APP-2 activity"
                    events={[
                      {who: 'claude', text: 'Claims APP-2 and stores the worklog after each step'},
                      {who: 'claude', text: 'Session ends: usage limit reached', tone: 'warn'},
                      {who: 'codex', text: 'Takes over the silent claim and reads “Next”'},
                      {who: 'codex', text: 'Files APP-5 under the same epic'},
                      {who: 'codex', text: 'Finishes APP-2, and APP-3 is ready', tone: 'accent'},
                    ]}
                  />
                ),
              },
            ]}
          />

          <div className={styles.flowShot}>
            <Screenshot
              name="tasks"
              phone
              alt="The Tasks view of the staple web UI: epics for checkout, onboarding and search with their tasks, two being worked on by claude and codex, four waiting on other work and three done."
              caption="The same idea in the web UI: epics with their tickets, who holds what, and what is still waiting."
            />
          </div>

          <div className={clsx(styles.split, styles.resume)}>
            <div className={styles.splitCopy}>
              <Eyebrow>Handoff and resume</Eyebrow>
              <Heading as="h3" size="lg">
                When a session dies, the ticket still knows.
              </Heading>
              <p className={styles.body}>
                The ticket shows who held it and how long they have been silent. Taking it over is a deliberate step,
                and it is logged: a claim never expires on its own.
              </p>
              <ul className={styles.points}>
                <li>The worklog says what is done, what is next and which files were touched.</li>
                <li>Work the plan did not foresee is filed as a ticket under the same epic, not in a file.</li>
                <li>Finishing a ticket makes the work that waited on it ready.</li>
              </ul>
              <Link to="/docs/handoff" className={styles.more}>
                Handoff and resume<span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className={styles.splitVisual}>
              <Terminal title="codex · app" lines={RESUME} className={styles.terminal} />
            </div>
          </div>
        </Section>

        <Section tone="subtle" id="human">
          <div className={clsx(styles.split, styles.humanHead)}>
            <div className={styles.splitCopy}>
              <Eyebrow>Human in the loop</Eyebrow>
              <Heading>You decide. You don’t babysit.</Heading>
              <p className={styles.body}>
                Agents take the next ready ticket on their own. You set the order, choose what needs your sign-off,
                and see at any moment what is done, what is next and who is on it.
              </p>
            </div>
            <ul className={clsx(styles.points, styles.humanPoints)}>
              <li>
                The <Link to="/docs/queue">pickup queue</Link> is the order agents take work in. Rank never lifts a
                blocker or a live claim.
              </li>
              <li>
                An <Link to="/docs/approval-gates">approval gate</Link> parks a parent, such as an epic, on a person:
                the tickets under it wait until you approve.
              </li>
              <li>
                <Link to="/docs/milestones">Milestones</Link> put a date and a definition of done on a set of epics and
                tasks, with progress and pace.
              </li>
              <li>
                <code>staple open</code> serves the <Link to="/docs/web-ui">web UI</Link> from your machine, with no
                daemon and no account.
              </li>
            </ul>
          </div>
          <Screenshot
            name="milestones"
            phone
            alt="The Milestones view: the Public beta milestone with its due date and progress, 2 of 10 tasks finished, and next up LUM-9, number 1 in the pickup order; below it the epics and tasks in the milestone, in order."
            caption="A milestone in the web UI: how far along it is, what waits on whom, and the ticket an agent takes next."
          />
        </Section>

        <Section id="alongside">
          <div className={styles.sectionHead}>
            <Eyebrow>Next to Linear, GitHub and ClickUp</Eyebrow>
            <Heading>Keep your team’s board. Give agents their own.</Heading>
            <Lead>
              staple does not replace your team’s tracker. It is the execution layer: the place where agents do the
              work, locally, ticket by ticket. Your team’s board stays where people plan, discuss and report.
            </Lead>
          </div>
          <Alongside />
          <div className={styles.integrations}>
            <p className={styles.integrationsLabel}>Integrations that keep the two in sync</p>
            <ul className={styles.integrationList}>
              {['GitHub Issues', 'ClickUp', 'Linear'].map((name) => (
                <li key={name} className={styles.integration}>
                  {name}
                  <span className={styles.planned}>Planned</span>
                </li>
              ))}
            </ul>
            <p className={styles.integrationsNote}>
              Planned, not shipped: today staple does not read from or write to any of them. Use it alongside them and
              carry items across yourself.
            </p>
          </div>
        </Section>

        <Section tone="subtle" width="narrow" id="origin" className={styles.origin}>
          <Eyebrow>Where it came from</Eyebrow>
          <Heading>Built out of daily work with agents.</Heading>
          <figure className={styles.quote}>
            <blockquote>
              <p>“I don’t want Markdown files acting as a backlog, especially for large features such as integrating multi-tenancy.”</p>
            </blockquote>
            <figcaption>staple’s author</figcaption>
          </figure>
          <p className={styles.body}>
            Plans died with sessions, two agents took the same task, and hosted trackers were too slow for an agent’s
            loop. The inspiration was Paperclip AI’s inbox, where agents or
            people file tickets and agents pick them up. The focus here is the tickets themselves: first-class, each
            carrying the complete context an agent needs to move the work forward.
          </p>
          <Link to="/docs/why-staple" className={styles.more}>
            Why staple<span aria-hidden="true">→</span>
          </Link>
        </Section>

        <Section id="underneath">
          <div className={styles.sectionHead}>
            <Eyebrow>Underneath</Eyebrow>
            <Heading>Small enough to carry. Strict where it counts.</Heading>
            <Lead>The rules are enforced by the store, not by a prompt, so they hold for every agent and every person.</Lead>
          </div>
          <div className={styles.facts}>
            <dl className={styles.factGrid}>
              {FACTS.map((fact, i) => (
                <div key={i} className={styles.fact}>
                  <dt className={styles.factLabel}>{fact.label}</dt>
                  <dd className={styles.factValue}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <CardGrid>
            <Card eyebrow="Dependencies" title="Work waits for what it needs" to="/docs/epics-and-dependencies">
              <p>A ticket with open blockers cannot be claimed, and a dependency cycle is refused on write.</p>
            </Card>
            <Card eyebrow="Pickup queue" title="Set the order once" to="/docs/queue">
              <p>
                Queue a task, an epic or a milestone. Advisory by default; under <code>strict</code>, an agent that
                skips ahead is refused and told what to take.
              </p>
            </Card>
            <Card eyebrow="Milestones" title="A date and a definition of done" to="/docs/milestones">
              <p>Members keep their place in the tree. Each goal criterion is judged met with evidence.</p>
            </Card>
            <Card eyebrow="Autopilot runs" title="Ticket after ticket, then stop" to="/docs/runs">
              <p>
                A budget per run: a ticket count, an end time or a rate-limit ceiling. Work lands as branches and pull
                requests for a person to merge.
              </p>
            </Card>
            <Card eyebrow="Web UI" title="Everything on one screen" to="/docs/web-ui">
              <p>Tasks, Queue, Graph, Milestones, Estimates and Usage, in light and dark, on a desk or a phone.</p>
            </Card>
            <Card eyebrow="MCP and CLI" title="One set of rules, two surfaces" to="/docs/mcp-tools">
              <p>
                Refusals are typed: <code>conflict</code> means pick another ticket, <code>gated</code> means a person
                has to act.
              </p>
            </Card>
          </CardGrid>
        </Section>

        <Section tone="subtle" className={styles.closing}>
          <Heading align="center">Move the plan out of Markdown.</Heading>
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
