import {Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {flushSync} from 'react-dom';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Button, {ButtonRow} from '@site/src/components/Button';
import CopyCommand from '@site/src/components/CopyCommand';
import {StatusGlyph, TrackerSync} from '@site/src/components/scenes';
import CompareTable, {Planned} from './parts/CompareTable';
import Faq from './parts/Faq';
import Install from './parts/Install';
import PlanFolder from './parts/PlanFolder';
import SerifFont from './parts/SerifFont';
import Steps from './parts/Steps';
import TicketChips, {PauseButton, fromBottom, useDrift, type ChipSpec} from './parts/TicketChips';
import {CHAPTERS, DESCRIPTION, FACTS, REPOSITORY, TITLE, type ChapterSpec, type FeatureSpec} from './parts/content';
import styles from './Blend.module.css';

// The blend landing page: one drawing sheet read in order. Every band has a legend on
// the left (a mono eyebrow and a serif heading) and its content on the right. In the
// walk-through the legend is the feature index: it stays in view while the stage beside
// it shows one feature at a time, with the one scene that belongs to it. The three
// steps are the spine: the strip under the hero, the groups of the index, and the
// kicker of every feature. The story and its terms follow docs/why-staple.md and the
// story landing page.

// Tickets of the docs' example epic (Multi-tenancy, prefix APP), as the web UI would
// list them, and where each sits: to the right of the copy from 1024 px, and below that
// in a band above the copy and one below it, measured from the hero's edges.
const CHIPS: ChipSpec[] = [
  {id: 'APP-9', title: 'Audit log per tenant', status: 'backlog', depth: 3, at: ['61%', '11%'], tablet: ['16%', '7.75rem'], drift: [-20, -12], seconds: 27, leaves: 'middle'},
  {id: 'APP-12', title: 'Rotate API keys per tenant', status: 'review', depth: 2, at: ['87%', '15%'], tablet: ['74%', '2.75rem'], drift: [-28, 12], seconds: 24, leaves: 'late'},
  {id: 'APP-2', title: 'Tenant id on every table', status: 'active', depth: 1, at: ['69%', '27%'], tablet: ['30%', '4.25rem'], phone: ['38%', '2.75rem'], drift: [40, -16], seconds: 19, leaves: 'late'},
  {id: 'APP-3', title: 'Scope queries by tenant', status: 'backlog', depth: 1, at: ['85%', '41%'], tablet: ['68%', '6.75rem'], phone: ['60%', '5.5rem'], drift: [-36, 12], seconds: 22, leaves: 'early'},
  {id: 'APP-7', title: 'Backfill tenant_id on invoices', status: 'done', depth: 2, at: ['65%', '50%'], drift: [26, 12], seconds: 23, leaves: 'early'},
  {id: 'APP-5', title: 'Tenant-aware rate limits', status: 'ready', depth: 1, at: ['78%', '62%'], tablet: ['26%', fromBottom(6.5)], phone: ['38%', fromBottom(8)], drift: [-34, -14], seconds: 21, leaves: 'middle'},
  {id: 'APP-4', title: 'Tenant-aware billing', status: 'blocked', depth: 2, at: ['91%', '73%'], drift: [-22, -12], seconds: 26, leaves: 'middle'},
  {id: 'APP-8', title: 'Tenant switcher in the admin', status: 'gated', depth: 1, at: ['68%', '80%'], tablet: ['62%', fromBottom(4.25)], phone: ['56%', fromBottom(5.25)], drift: [34, -18], seconds: 20, leaves: 'late'},
  {id: 'APP-11', title: 'Index tenant_id on payments', status: 'done', depth: 3, at: ['79%', '88%'], drift: [-24, -8], seconds: 28, leaves: 'early'},
  {id: 'APP-10', title: 'Remove the global admin query', status: 'backlog', depth: 3, at: ['53%', '93%'], tablet: ['84%', fromBottom(8)], drift: [22, -10], seconds: 25, leaves: 'late'},
];

function Arrow(): ReactNode {
  return (
    <span className={styles.arrow} aria-hidden="true">
      →
    </span>
  );
}

function Hero(): ReactNode {
  const {ref, allowed, motion, paused, togglePaused} = useDrift();
  return (
    <section ref={ref} className={styles.hero}>
      <TicketChips chips={CHIPS} motion={motion} wideFrom={1024} />
      <div className={styles.heroCopy}>
        <p className={styles.eyebrow}>Local-first task tracker</p>
        <h1 className={styles.heroTitle}>
          <span className={styles.line}>From plan</span> <span className={styles.line}>
            to <em>done</em>.
          </span>
        </h1>
        <p className={styles.heroLead}>
          staple turns an implementation plan into an epic and tickets that carry the whole context. Agents work them
          one by one, and a new session picks up where a dead one stopped.
        </p>
        <ButtonRow>
          <CopyCommand command="npx staple-cli" />
          <Button to="/docs/getting-started" variant="secondary" size="lg">
            Get started
          </Button>
        </ButtonRow>
        <p className={styles.fineprint}>Node 22.5 or later. One SQLite file per repository.</p>
      </div>
      {allowed && <PauseButton paused={paused} onToggle={togglePaused} className={styles.pause} />}
    </section>
  );
}

type TourFeature = FeatureSpec & {chapter: ChapterSpec; step: number};

// The nine features in one list, each knowing the step it belongs to.
const FEATURES: TourFeature[] = CHAPTERS.flatMap((chapter, c) => chapter.features.map((feature) => ({...feature, chapter, step: c + 1})));

const two = (n: number): string => String(n).padStart(2, '0');

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A line of a headline, with the feature's accent words in italic. */
function accented(line: string, accent: string): ReactNode {
  const at = line.indexOf(accent);
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at)}
      <em>{accent}</em>
      {line.slice(at + accent.length)}
    </>
  );
}

// When the walk-through is a pinned frame: a landscape screen wide and tall enough for
// the index, the copy and the scene side by side, and not so tall that one feature would
// be lost in it. The heights are in `em`, which a media query reads as the reader's own
// font size, because the frame's content grows with it. The stylesheet lays the frame
// out under the same query, and only on the class this component sets once it runs:
// without the script, the features flow down the page.
// The frame is as tall as the small viewport (`svh`): a browser without that unit keeps
// the plain layout.
const PINNED = '(min-width: 1024px) and (min-width: 64em) and (min-height: 40em) and (max-height: 100em) and (orientation: landscape)';

// Whether this document has shown the walk-through before. The first time, the page is
// hydrating the server's HTML, which has the plain layout, and it may be a reload that
// the browser scrolls back itself. When the reader comes back to the page within the
// site, it is laid out pinned from the start, so the browser puts the scroll position
// back in the layout it was saved in.
let arrived = false;

/** Whether the walk-through is pinned on this screen. */
function pins(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports('height', '100svh') && window.matchMedia(PINNED).matches;
}

/** True when the page was reloaded or reached through the history: the browser puts the scroll position back itself. */
function restored(): boolean {
  const [entry] = window.performance?.getEntriesByType?.('navigation') ?? [];
  const type = (entry as PerformanceNavigationTiming | undefined)?.type;
  return type === 'reload' || type === 'back_forward';
}

/**
 * Where the reader is: at one of the walk-through's features, or past it, at a band of
 * the sheet (its index among the sheet's children) whose top is `offset` from the top
 * of the screen.
 */
type Place = {feature: number} | {band: number; offset: number};

/**
 * The walk-through. Its markup is a list of nine sections in reading order, which is
 * what a phone shows. Where `PINNED` matches, it becomes a tall track with a frame
 * pinned under the navbar: the scroll position picks the feature, the index marks it,
 * and only that feature's section shows. The index is then a vertical tablist and the
 * sections are its panels.
 */
function Tour(): ReactNode {
  const [pinned, setPinned] = useState(() => arrived && pins());
  const [active, setActive] = useState(0);
  const track = useRef<HTMLElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const tabs = useRef<(HTMLAnchorElement | null)[]>([]);
  const panels = useRef<(HTMLElement | null)[]>([]);
  // What is on the page now, for the handlers that outlive a render.
  const now = useRef({pinned, active: 0});
  // Set when the page was opened by a link to a feature and is pinned from the start.
  const fromLink = useRef(false);
  // Where the reader is, read on every scroll while the layout is at rest; and where they
  // were before the layout changed, kept until the new layout is in place.
  const last = useRef<Place | null>(null);
  const place = useRef<Place | null>(null);
  // A feature the browser has just found a match in, and until when it is kept on stage.
  const held = useRef<{feature: number; until: number} | null>(null);
  const count = FEATURES.length;

  /** Where the reader is: null while the walk-through has not reached the middle of the screen. */
  const locate = useCallback((): Place | null => {
    const node = track.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const line = window.innerHeight / 2;
    if (rect.top >= line) return null;
    // Once the band after the walk-through is on the screen, that band is what the reader
    // keeps their place by.
    if (rect.bottom < window.innerHeight) {
      // The band at the top of the screen, so the one being read stays where it is.
      const bands = Array.from(node.parentElement?.children ?? []);
      const band = bands.findIndex((child, i) => i > bands.indexOf(node) && child.getBoundingClientRect().bottom > 0);
      if (band < 0) return null;
      return {band, offset: bands[band].getBoundingClientRect().top};
    }
    if (now.current.pinned) return {feature: now.current.active};
    const under = panels.current.filter((panel) => panel && panel.getBoundingClientRect().top <= line).length - 1;
    return {feature: Math.max(0, under)};
  }, []);

  useEffect(() => {
    const query = window.matchMedia(PINNED);
    const update = () => {
      const next = pins();
      if (next === now.current.pinned) return;
      // The two layouts differ in height by more than a screen, and by the time a media
      // query reports a change the stylesheet has already let go of the frame: the place
      // to put the reader back at is the one read on the last scroll.
      place.current = last.current;
      // The browser's own scroll anchoring would move the page again after this component
      // has put the reader back: it is off until the new layout has been painted.
      document.documentElement.style.overflowAnchor = 'none';
      setPinned(next);
    };
    // An address that names a feature (`/blend#handoff`) opens on that feature, as the
    // router goes to the element an address names. The browser would otherwise put back a
    // scroll position for it after the feature is on stage, measured in whichever layout
    // it was saved in, so it is told not to (scroll restoration is kept per address). On
    // the first load of the address, the reader may have scrolled on before this ran: then
    // they stay where they are.
    const linked = FEATURES.findIndex((feature) => `#${feature.id}` === window.location.hash);
    const there = linked >= 0 && Math.abs(panels.current[linked]?.getBoundingClientRect().top ?? Infinity) < window.innerHeight / 2;
    const again = arrived || window.history.scrollRestoration === 'manual';
    fromLink.current = pins() && linked >= 0 && (again || (!restored() && there));
    arrived = true;
    if (linked >= 0) window.history.scrollRestoration = 'manual';
    last.current = locate();
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [locate]);

  // In the plain layout, where the reader is, for a change to the pinned one.
  useEffect(() => {
    if (pinned) return undefined;
    let waiting = 0;
    const read = () => {
      waiting = 0;
      if (!now.current.pinned) last.current = locate();
    };
    const onScroll = () => {
      if (!waiting) waiting = window.requestAnimationFrame(read);
    };
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (waiting) window.cancelAnimationFrame(waiting);
    };
  }, [pinned, locate]);

  /** Where the track is: how far the page has scrolled into it, and how far it can. */
  const measure = useCallback(() => {
    const node = track.current;
    const pin = frame.current;
    if (!node || !pin) return null;
    const rect = node.getBoundingClientRect();
    const top = Number.parseFloat(window.getComputedStyle(pin).top) || 0;
    return {into: top - rect.top, span: rect.height - pin.offsetHeight};
  }, []);

  /** Show a feature: the page moves to its place in the track, which the pinned frame hides. */
  const select = useCallback(
    (i: number, focus = false) => {
      const at = measure();
      if (!at) return;
      const to = window.scrollY - at.into + ((i + 0.5) / count) * at.span;
      if (Math.abs(to - window.scrollY) >= 1) window.scrollTo({top: to, behavior: 'instant'});
      setActive(i);
      if (focus) tabs.current[i]?.focus({preventScroll: true});
    },
    [measure, count],
  );

  // The scroll position picks the feature.
  useEffect(() => {
    if (!pinned) {
      setActive(0);
      return undefined;
    }
    let waiting = 0;
    const read = () => {
      waiting = 0;
      const hold = held.current;
      if (hold && window.performance.now() < hold.until) {
        // The browser scrolls to a match it found as if the frame were not pinned: go back to the feature it is in.
        select(hold.feature);
        return;
      }
      held.current = null;
      const at = measure();
      // No span: the stylesheet has let go of the frame and the layout is about to change.
      if (!at || at.span <= 0) return;
      const i = Math.min(count - 1, Math.max(0, Math.floor((at.into / at.span) * count)));
      setActive(i);
      const where = locate();
      last.current = where && 'feature' in where ? {feature: i} : where;
    };
    const onScroll = () => {
      if (!waiting) waiting = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (waiting) window.cancelAnimationFrame(waiting);
    };
  }, [pinned, measure, select, locate, count]);

  // A link to a feature (`/blend#handoff`) opens on that feature: when the page is opened
  // by that link, and whenever the hash changes after that.
  useEffect(() => {
    if (!pinned) return undefined;
    const open = () => {
      const i = FEATURES.findIndex((feature) => `#${feature.id}` === window.location.hash);
      if (i < 0) return;
      // Until the page has loaded, the browser may scroll to the element the address names
      // once more, as if the frame were not pinned: the feature is kept on stage till then.
      const loading = document.readyState !== 'complete';
      held.current = {feature: i, until: window.performance.now() + (loading ? 1500 : 150)};
      select(i);
    };
    const loaded = () => {
      if (held.current) held.current.until = Math.min(held.current.until, window.performance.now() + 150);
    };
    if (fromLink.current) open();
    fromLink.current = false;
    window.addEventListener('hashchange', open);
    window.addEventListener('load', loaded);
    return () => {
      window.removeEventListener('hashchange', open);
      window.removeEventListener('load', loaded);
    };
  }, [pinned, select]);

  useIsomorphicLayoutEffect(() => {
    const before = now.current;
    now.current = {pinned, active};
    const moved = pinned && before.active !== active;
    const inPanel = moved && Boolean(panels.current[before.active]?.contains(document.activeElement));
    const onTab = moved && tabs.current[before.active] === document.activeElement;

    // The features that are not showing stay in the page for the browser's find-in-page
    // (`hidden="until-found"`, which React does not write, so it is set here): a match in
    // one of them shows that feature. They are left unrendered by the stylesheet; a
    // browser that cannot do that hides them.
    // The one that shows takes focus as a tab panel; it is set here too, after the check
    // above, because taking it from a panel that has focus drops the focus.
    const skips = typeof CSS !== 'undefined' && CSS.supports('content-visibility', 'hidden');
    panels.current.forEach((panel, i) => {
      if (!panel) return;
      const hide = pinned && i !== active;
      if (hide) panel.setAttribute('hidden', 'until-found');
      else panel.removeAttribute('hidden');
      panel.style.visibility = hide && !skips ? 'hidden' : '';
      if (pinned && i === active) panel.tabIndex = 0;
      else panel.removeAttribute('tabindex');
    });

    // Focus that was in the feature, or on the tab, that scrolling has just replaced goes
    // to the one that came, so a keyboard user is not dropped.
    if (inPanel) panels.current[active]?.focus({preventScroll: true});
    else if (onTab) tabs.current[active]?.focus({preventScroll: true});

    // After a change of layout, the reader is put back where they were.
    if (before.pinned !== pinned) {
      window.requestAnimationFrame(() => {
        document.documentElement.style.overflowAnchor = '';
      });
    }
    const was = place.current;
    place.current = null;
    if (!was || before.pinned === pinned) return;
    if ('band' in was) {
      const band = track.current?.parentElement?.children[was.band];
      if (band) window.scrollTo({top: window.scrollY + band.getBoundingClientRect().top - was.offset, behavior: 'instant'});
    } else if (pinned) select(was.feature);
    else panels.current[was.feature]?.scrollIntoView({block: 'start', behavior: 'instant'});
  }, [pinned, active, select]);

  useEffect(() => {
    if (!pinned) return undefined;
    const nodes = panels.current.slice();
    // The browser scrolls to the match as soon as this returns: the feature has to be on stage by then.
    const found = nodes.map((_, i) => () => {
      held.current = {feature: i, until: window.performance.now() + 400};
      flushSync(() => select(i));
    });
    nodes.forEach((panel, i) => panel?.addEventListener('beforematch', found[i]));
    return () => nodes.forEach((panel, i) => panel?.removeEventListener('beforematch', found[i]));
  }, [pinned, select]);

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, i: number) => {
    const to = {ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: count - 1, ' ': i}[event.key];
    if (to === undefined) return;
    event.preventDefault();
    select(Math.min(count - 1, Math.max(0, to)), true);
  };

  return (
    <section ref={track} className={clsx(styles.band, styles.tour, pinned && styles.pins)} aria-labelledby="blend-tour">
      <div ref={frame} className={styles.frame}>
        <div className={styles.index}>
          <div className={styles.indexHead}>
            <p className={styles.eyebrow}>The walk-through</p>
            <h2 id="blend-tour" className={clsx(styles.title, styles.tick, styles.indexTitle)}>
              One feature at a <em>time</em>.
            </h2>
            <p className={styles.indexLede}>Nine features, in the order a plan meets them.</p>
          </div>
          {/* A list of links to the features, or, where the frame is pinned, the tabs that show them. */}
          <div className={styles.indexNav} role={pinned ? undefined : 'navigation'} aria-label={pinned ? undefined : 'Features'}>
            <div className={styles.tabs} role={pinned ? 'tablist' : undefined} aria-orientation={pinned ? 'vertical' : undefined} aria-label={pinned ? 'Features' : undefined}>
              {FEATURES.map((feature, i) => (
                <Fragment key={feature.id}>
                  {feature.id === feature.chapter.features[0].id && (
                    <p className={styles.group} aria-hidden={pinned || undefined}>
                      <span className={styles.groupNumber}>{two(feature.step)}</span>
                      <span>{feature.chapter.title}</span>
                      <span className={styles.groupGlyph} aria-hidden="true">
                        <StatusGlyph status={feature.chapter.status} />
                      </span>
                    </p>
                  )}
                  <a
                    ref={(node) => {
                      tabs.current[i] = node;
                    }}
                    id={`blend-tab-${feature.id}`}
                    href={`#${feature.id}`}
                    className={clsx(styles.tab, i === active && styles.tabOn)}
                    role={pinned ? 'tab' : undefined}
                    aria-selected={pinned ? i === active : undefined}
                    aria-controls={pinned ? feature.id : undefined}
                    tabIndex={pinned && i !== active ? -1 : undefined}
                    onClick={
                      pinned
                        ? (event) => {
                            event.preventDefault();
                            select(i);
                          }
                        : undefined
                    }
                    onKeyDown={pinned ? (event) => onKeyDown(event, i) : undefined}>
                    {feature.pill}
                  </a>
                </Fragment>
              ))}
            </div>
          </div>
          <p className={styles.counter} aria-hidden="true">
            <span className={styles.counterNow}>{two(active + 1)}</span> / {two(count)}
          </p>
        </div>

        <div className={styles.features}>
          {FEATURES.map((feature, i) => {
            const on = i === active;
            return (
              <section
                key={feature.id}
                ref={(node) => {
                  panels.current[i] = node;
                }}
                id={feature.id}
                className={clsx(styles.feature, on && styles.featureOn)}
                role={pinned ? 'tabpanel' : undefined}
                aria-labelledby={pinned ? `blend-tab-${feature.id}` : undefined}
                aria-hidden={pinned && !on ? true : undefined}>
                <div className={styles.featureHead}>
                  <div className={styles.kicker}>
                    <p className={styles.kickerStep}>
                      Step {feature.step}: {feature.chapter.title}
                    </p>
                    <p className={styles.pill}>{feature.pill}</p>
                  </div>
                  <h3 className={styles.featureTitle}>
                    <span className={styles.line}>{accented(feature.title[0], feature.accent)}</span>{' '}
                    <span className={styles.line}>{accented(feature.title[1], feature.accent)}</span>
                  </h3>
                </div>
                <div className={styles.featureScene}>
                  {/* A feature that comes on stage plays its scene from the start. */}
                  <Fragment key={on ? 'on' : 'off'}>{feature.scene}</Fragment>
                </div>
                <div className={styles.featureText}>
                  {feature.body && <p className={styles.body}>{feature.body}</p>}
                  {feature.points && (
                    <ul className={styles.points}>
                      {feature.points.map((point, p) => (
                        <li key={p}>{point}</li>
                      ))}
                    </ul>
                  )}
                  <Link to={feature.link.to} className={styles.more}>
                    {feature.link.label}
                    <Arrow />
                  </Link>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default function Blend(): ReactNode {
  return (
    <Layout title={TITLE} description={DESCRIPTION}>
      {/* The serif face belongs to this page and the bento page: fetched early here, never on another page. */}
      <SerifFont />
      <main className={styles.page}>
        <div className={styles.top}>
          <Hero />
        </div>

        <div className={styles.sheet}>
          <section className={clsx(styles.band, styles.start)} aria-labelledby="blend-steps">
            <div className={styles.legend}>
              <p className={styles.eyebrow}>What it is</p>
              <p className={styles.statement}>
                staple is a local-first task tracker for coding agents: one SQLite file per repository, next to your
                team’s tracker.
              </p>
            </div>
            <div className={styles.startSteps}>
              <h2 id="blend-steps" className={styles.hidden}>
                From plan to done in three steps
              </h2>
              <Steps className={styles.steps} />
            </div>
          </section>

          <section className={clsx(styles.band, styles.split)} aria-labelledby="blend-problem">
            <div className={styles.legend}>
              <p className={styles.eyebrow}>The problem</p>
              <h2 id="blend-problem" className={clsx(styles.title, styles.tick)}>
                A folder of plans is <em>not</em> a backlog.
              </h2>
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
              <Link to="/docs/why-staple" className={styles.more}>
                Why staple
                <Arrow />
              </Link>
            </div>
            <div className={styles.figure}>
              <div className={styles.fragment}>
                <PlanFolder />
              </div>
            </div>
          </section>

          <Tour />

          <section className={clsx(styles.band, styles.split, styles.alongside)} aria-labelledby="blend-alongside">
            <div className={styles.legend}>
              <p className={styles.eyebrow}>Next to Linear, GitHub and ClickUp</p>
              <h2 id="blend-alongside" className={clsx(styles.title, styles.tick)}>
                <span className={styles.line}>Keep your team’s board.</span>{' '}
                <span className={styles.line}>
                  Give agents <em>their own</em>.
                </span>
              </h2>
            </div>
            <div className={styles.prose}>
              <p>
                staple does not replace your team’s tracker. It is the execution layer: the place where agents do the
                work, locally, ticket by ticket. Your team’s board stays where people plan, discuss and report.
              </p>
              <p>
                <Planned />
                Integrations that keep the two in sync, with GitHub Issues, ClickUp and Linear, are planned, not
                shipped. Today staple does not read from or write to any of them: use it alongside them and carry
                items across yourself.
              </p>
            </div>
            <div className={styles.figure}>
              <TrackerSync fade="none" />
            </div>
            <div className={styles.compare}>
              <CompareTable />
            </div>
          </section>

          <section className={clsx(styles.band, styles.split, styles.underneath)} aria-labelledby="blend-underneath">
            <div className={styles.legend}>
              <p className={styles.eyebrow}>Underneath</p>
              <h2 id="blend-underneath" className={clsx(styles.title, styles.tick)}>
                <span className={styles.line}>Small enough to carry.</span>{' '}
                <span className={styles.line}>
                  <em>Strict</em> where it counts.
                </span>
              </h2>
              <p className={styles.legendText}>
                The rules are enforced by the store, not by a prompt, so they hold for every agent and every person.
              </p>
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

          <section className={clsx(styles.band, styles.faq)} aria-labelledby="blend-faq">
            <div className={styles.legend}>
              <div className={styles.legendSticky}>
                <p className={styles.eyebrow}>FAQ</p>
                <h2 id="blend-faq" className={clsx(styles.title, styles.tick)}>
                  Questions, <em>answered</em>.
                </h2>
                <p className={styles.legendText}>The short answers. Each one ends at the page of the docs that has the long one.</p>
              </div>
            </div>
            <div className={styles.faqBody}>
              <Faq className={styles.faqList} linkClassName={styles.more} linkMark={<Arrow />} />
            </div>
          </section>

          <section className={clsx(styles.band, styles.closing)} aria-labelledby="blend-install">
            <p className={styles.eyebrow}>Get started</p>
            <h2 id="blend-install" className={styles.closingTitle}>
              Move the plan <em>out of</em> Markdown.
            </h2>
            <Install />
            <p className={styles.closingLead}>
              One command sets up the repository and opens the web UI. Your agents connect over MCP. Node 22.5 or
              later, one SQLite file per repository.
            </p>
            <div className={styles.closingActions}>
              <Button to="/docs/getting-started" size="lg">
                Get started
              </Button>
              <Button to={REPOSITORY} variant="secondary" size="lg">
                View on GitHub
              </Button>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  );
}
