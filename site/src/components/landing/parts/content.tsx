import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {ApprovalGate, AutopilotRun, Budget, Handoff, MilestoneGoal, OneStore, PlanToTickets, QueuePickup, TicketContext, type Status} from '@site/src/components/scenes';

// What the experiment landing pages say, in one place: the page title, the three steps,
// the nine features of the walk-through, the comparison, the figures and the FAQ. The
// story and its terms follow docs/why-staple.md and the story landing page; every
// figure is counted from the source, as there.

export const TITLE = 'Implementation plans your agents can finish';
export const DESCRIPTION =
  'staple turns an implementation plan into an epic and tickets that carry their full context, so coding agents work through it, resume after a session dies and file new work under the same epic. Local-first, next to your team’s tracker.';

export const REPOSITORY = 'https://github.com/vpetkovic/staple-tracker';

// Each step carries the status a ticket has at that point, as the web UI draws it.
export const STEPS: {title: string; text: string; status: Status}[] = [
  {title: 'Write the plan.', text: 'The plan you and your agent agreed on: its steps, and what depends on what.', status: 'ready'},
  {title: 'Agents work the tickets.', text: 'Each step is a ticket. An agent claims one, keeps a worklog on it and finishes it.', status: 'active'},
  {title: 'You approve.', text: 'You set the order and choose what needs your sign-off. Gated work waits for you.', status: 'done'},
];

export type FeatureSpec = {
  id: string;
  /** The feature's name, as the docs call it. */
  pill: string;
  /** The headline, in two lines. */
  title: [string, string];
  /** The words of the headline a page with the serif face sets in italic. */
  accent: string;
  /** A paragraph, or three short points. */
  body?: ReactNode;
  points?: ReactNode[];
  link: {to: string; label: string};
  /** Exactly one scene. */
  scene: ReactNode;
};

export type ChapterSpec = {
  id: string;
  title: string;
  /** The status a ticket has at this step. */
  status: Status;
  features: FeatureSpec[];
};

// The walk-through, in the order of the three steps.
export const CHAPTERS: ChapterSpec[] = [
  {
    id: 'plan',
    title: 'Write the plan',
    status: 'ready',
    features: [
      {
        id: 'plans-become-tickets',
        pill: 'Plans become tickets',
        title: ['A plan becomes an epic.', 'Its steps are tickets.'],
        accent: 'tickets',
        body: (
          <>
            Brainstorm and write the implementation plan as you do today. Each step becomes a ticket under the epic,
            with what it waits on, and the plan is stored on the epic as a document.
          </>
        ),
        link: {to: '/docs/plans-to-tickets', label: 'Plans become tickets'},
        scene: <PlanToTickets fade="none" />,
      },
      {
        id: 'ticket-context',
        pill: 'Ticket context',
        title: ['All an agent needs', 'is on the ticket.'],
        accent: 'on the ticket',
        points: [
          'The plan, the worklog and the comments sit on the ticket, next to the tickets it waits on.',
          'An agent that opens a ticket finds everything it needs there.',
          'Work the plan did not foresee is filed as a ticket under the same epic, not in a file.',
        ],
        link: {to: '/docs/working-a-ticket', label: 'How an agent works a ticket'},
        scene: <TicketContext fade="none" />,
      },
    ],
  },
  {
    id: 'work',
    title: 'Agents work the tickets',
    status: 'active',
    features: [
      {
        id: 'pickup-queue',
        pill: 'Pickup queue',
        title: ['Agents always know', 'what comes next.'],
        accent: 'next',
        body: (
          <>
            The pickup queue is the order agents take work in. An agent that asks what to take next gets the first
            ticket in that order it can actually work. Rank never lifts a blocker or a live claim.
          </>
        ),
        link: {to: '/docs/queue', label: 'The pickup queue'},
        scene: <QueuePickup fade="none" />,
      },
      {
        id: 'handoff',
        pill: 'Handoff',
        title: ['When a session dies,', 'the ticket still knows.'],
        accent: 'still',
        points: [
          'The ticket shows who held it and how long they have been silent.',
          'The worklog says what is done, what is next and which files were touched.',
          'Taking it over is a deliberate step, and it is logged: a claim never expires on its own.',
        ],
        link: {to: '/docs/handoff', label: 'Handoff and resume'},
        scene: <Handoff fade="none" />,
      },
      {
        id: 'autopilot-runs',
        pill: 'Autopilot runs',
        title: ['Ticket after ticket,', 'then stop.'],
        accent: 'stop',
        body: (
          <>
            A run lets one agent work an epic, a milestone or the whole queue, one ticket after another, until the work
            is done, a budget runs out or something needs you. A run never merges: it leaves branches and draft pull
            requests for you.
          </>
        ),
        link: {to: '/docs/runs', label: 'Autopilot runs'},
        scene: <AutopilotRun fade="none" />,
      },
      {
        id: 'one-store',
        pill: 'CLI, MCP and web UI',
        title: ['One store.', 'Three ways in.'],
        accent: 'Three',
        body: (
          <>
            The CLI, the MCP tools and the web UI work on the same tickets, and the rules are enforced by the store,
            not by a prompt, so they hold for every agent and every person. A change made anywhere shows up in the web
            UI within seconds.
          </>
        ),
        link: {to: '/docs/mcp-tools', label: 'MCP tools'},
        scene: <OneStore fade="none" />,
      },
    ],
  },
  {
    id: 'approve',
    title: 'You approve',
    status: 'done',
    features: [
      {
        id: 'approval-gates',
        pill: 'Approval gates',
        title: ['You decide.', 'You don’t babysit.'],
        accent: 'decide',
        points: [
          'A gate holds an epic, or any ticket with children, on a named person.',
          'Until that person approves, no agent can start the work under it, and the epic cannot close.',
          'Approve it, let part of it through, or send it back.',
        ],
        link: {to: '/docs/approval-gates', label: 'Approval gates'},
        scene: <ApprovalGate fade="none" />,
      },
      {
        id: 'milestones',
        pill: 'Milestones and goals',
        title: ['A date and', 'a definition of done.'],
        accent: 'done',
        body: (
          <>
            A milestone gathers epics and tickets from anywhere in the tree without moving them, and gives them an
            order, a target date and a goal. The goal is a list of criteria, and each one is judged with evidence: met,
            unmet or unknown.
          </>
        ),
        link: {to: '/docs/milestones', label: 'Milestones and goals'},
        scene: <MilestoneGoal fade="none" />,
      },
      {
        id: 'budget',
        pill: 'Budget and estimates',
        title: ['Know what', 'the work costs.'],
        accent: 'costs',
        points: [
          'Estimate a ticket when you plan it, not when it is finished.',
          'staple measures the agent work that went into it, and learns how far off your estimates run.',
          'It records your provider’s usage limits on this machine and warns when your pace eats into a reserve.',
        ],
        link: {to: '/docs/budget-and-estimates', label: 'Budget and estimates'},
        scene: <Budget fade="none" />,
      },
    ],
  },
];

export const COMPARE: {term: string; tracker: string; staple: string}[] = [
  {term: 'Used by', tracker: 'People planning and reporting', staple: 'Agents doing the work, and you watching it'},
  {term: 'Runs', tracker: 'Hosted, over the network', staple: 'Locally, one file per repository'},
  {term: 'Holds', tracker: 'Features, priorities, discussion', staple: 'Epics, tickets, plans, worklogs, claims'},
];

export const FACTS: {value: string; label: string}[] = [
  {value: '1', label: 'SQLite file per repository: no account, no server to run'},
  {value: '65', label: 'MCP tools, each calling the same store method as the CLI'},
  {value: '6', label: 'views in the web UI, from Tasks to Usage'},
  {value: '0', label: 'network calls until you opt in to sync or live usage checks'},
];

// Every answer says what the docs say, and ends at the page that says it.
export const FAQ: {question: string; answer: ReactNode; link: {to: string; label: string}}[] = [
  {
    question: 'Does staple replace Linear, GitHub Issues or ClickUp?',
    answer: (
      <>
        No. staple is the execution layer: the place where agents do the work, locally, ticket by ticket. Your team’s
        board stays where people plan, discuss and report. Integrations that keep the two in sync are planned, not
        shipped: today staple does not read from or write to any of them.
      </>
    ),
    link: {to: '/docs/why-staple#next-to-linear-github-and-clickup', label: 'Next to Linear, GitHub and ClickUp'},
  },
  {
    question: 'Which agents does it work with?',
    answer: (
      <>
        Claude Code, Codex or any MCP client. Agents work the tracker through staple’s MCP server, which the same
        package starts. You set it up once per machine, and every repository with a <code>.staple/</code> folder works.
      </>
    ),
    link: {to: '/docs/connect-your-agent', label: 'Connect your agent'},
  },
  {
    question: 'What happens when a session dies in the middle of a ticket?',
    answer: (
      <>
        The ticket still shows who held it and how long they have been silent, and the worklog says where to continue.
        Another session, or another agent in a different harness, takes it over and carries on. Takeover is a
        deliberate step, and it is logged.
      </>
    ),
    link: {to: '/docs/handoff', label: 'Handoff and resume'},
  },
  {
    question: 'Can two agents take the same ticket?',
    answer: (
      <>
        No. The claim is atomic: when two agents race for one ticket, exactly one gets it, and the other is told to
        pick a different one. A ticket with{' '}
        <Link to="/docs/epics-and-dependencies">open blockers</Link> cannot be claimed at all.
      </>
    ),
    link: {to: '/docs/working-a-ticket', label: 'How an agent works a ticket'},
  },
  {
    question: 'Where do my tickets live? Do I need an account?',
    answer: (
      <>
        Each repository keeps its tickets in one SQLite file, <code>.staple/staple.db</code>. There is no account, no
        server and no network call between an agent and its next ticket, and it works offline.{' '}
        <Link to="/docs/cloud-sync">Cloud sync</Link> between machines is optional and off until you turn it on.
      </>
    ),
    link: {to: '/docs/why-staple', label: 'Why staple'},
  },
  {
    question: 'How do I stay in control of what agents do?',
    answer: (
      <>
        You set the order agents take work in with the <Link to="/docs/queue">pickup queue</Link>, make work wait for
        your sign-off with an approval gate, and follow everything in the local <Link to="/docs/web-ui">web UI</Link>{' '}
        that <code>staple open</code> starts.
      </>
    ),
    link: {to: '/docs/approval-gates', label: 'Approval gates'},
  },
  {
    question: 'Can an agent keep going without me?',
    answer: (
      <>
        Yes, with an autopilot run: every ticket in an epic, a milestone or the whole queue, one after another, until
        the work is done, a budget runs out or something needs you. After each ticket, staple decides whether the run
        goes on, not the prompt. A run never merges.
      </>
    ),
    link: {to: '/docs/runs', label: 'Autopilot runs'},
  },
  {
    question: 'What do I need to install?',
    answer: (
      <>
        Node 22.5 or later, nothing else. Run <code>npx staple-cli</code> at the root of a git repository: the first
        run asks a few questions, sets the repository up and opens the web UI.
      </>
    ),
    link: {to: '/docs/getting-started', label: 'Install and first workspace'},
  },
];
