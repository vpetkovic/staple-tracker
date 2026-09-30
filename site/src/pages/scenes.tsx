import {useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import NoIndex from '@site/src/components/landing/NoIndex';
import Section from '@site/src/components/Section';
import Eyebrow from '@site/src/components/Eyebrow';
import Heading, {Lead} from '@site/src/components/Heading';
import {SCENES, QueuePickup} from '@site/src/components/scenes';
import styles from './scenes.module.css';

// The review page for the scene kit: every scene by name, at the width of the cell it
// may be put in. Not linked from anywhere, noindex, and out of the sitemap.

const WIDTHS: {id: string; label: string; width?: string}[] = [
  {id: 'fill', label: 'Fill'},
  {id: 'cell', label: 'Cell 300', width: '18.75rem'},
  {id: 'column', label: 'Column 420', width: '26.25rem'},
  {id: 'panel', label: 'Panel 640', width: '40rem'},
];

export default function ScenesPage(): ReactNode {
  const [width, setWidth] = useState('fill');
  // Bumping a scene's count remounts it, which plays it again from the start.
  const [plays, setPlays] = useState<Record<string, number>>({});
  const chosen = WIDTHS.find((w) => w.id === width);

  return (
    <Layout title="Scenes" description="The animated pieces of staple's UI that the landing pages are built from, one per feature.">
      <NoIndex />
      <main>
        <Section spacing="tight">
          <Eyebrow>Scene kit</Eyebrow>
          <Heading as="h1" size="xl">
            Ten scenes, one per feature.
          </Heading>
          <Lead>
            Each is a small piece of staple’s UI rebuilt in HTML and CSS. It starts when it scrolls into view, plays once and rests on its final state. A scene adapts to the
            width of the cell it sits in: try the widths below.
          </Lead>
          <div className={styles.controls} role="group" aria-label="Scene width">
            {WIDTHS.map((w) => (
              <button key={w.id} type="button" className={clsx(styles.control, w.id === width && styles.controlOn)} aria-pressed={w.id === width} onClick={() => setWidth(w.id)}>
                {w.label}
              </button>
            ))}
          </div>
        </Section>

        <Section spacing="tight" className={styles.list}>
          <ol className={clsx(styles.grid, chosen?.width && styles.gridSingle)}>
            {SCENES.map(({name, feature, story, Component}, i) => (
              <li key={name} id={name} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.number} aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className={styles.itemText}>
                    <h2 className={styles.name}>
                      {feature} <code className={styles.component}>{name}</code>
                    </h2>
                    <p className={styles.story}>{story}</p>
                  </div>
                  <button type="button" className={styles.replay} onClick={() => setPlays((p) => ({...p, [name]: (p[name] ?? 0) + 1}))} aria-label={`Replay ${feature}`}>
                    Replay
                  </button>
                </div>
                <div className={styles.stage} style={chosen?.width ? {maxWidth: chosen.width} : undefined}>
                  <Component key={plays[name] ?? 0} />
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section tone="subtle" spacing="tight">
          <Heading as="h2" size="md">
            Looping, with a pause control
          </Heading>
          <p className={styles.story}>
            Any scene takes <code>loop</code>. It then replays while it is in view, and shows a pause control that works by keyboard. With reduced motion it rests on the final
            state and has no control.
          </p>
          <div className={styles.loop}>
            <QueuePickup loop />
          </div>
        </Section>
      </main>
    </Layout>
  );
}
