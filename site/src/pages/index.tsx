import type {ReactNode} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Section from '@site/src/components/Section';
import Eyebrow from '@site/src/components/Eyebrow';
import Heading, {Lead} from '@site/src/components/Heading';
import Button, {ButtonRow} from '@site/src/components/Button';
import Card, {CardGrid} from '@site/src/components/Card';
import Terminal from '@site/src/components/Terminal';
import styles from './index.module.css';

// A placeholder hero built from the design-system primitives in src/components.
// The landing page work replaces the content; the primitives stay.
export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout description={siteConfig.tagline}>
      <main>
        <Section className={styles.hero}>
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <Eyebrow>Local-first task tracker</Eyebrow>
              <Heading as="h1">Task tracking for coding agents.</Heading>
              <Lead>
                Agents claim tickets, keep their plan and worklog on the ticket, hand work off and finish it. You
                follow along, set the order and approve what matters in a local web UI.
              </Lead>
              <ButtonRow>
                <Button to="/docs" size="lg">
                  Read the docs
                </Button>
                <Button to="https://github.com/vpetkovic/staple-tracker" variant="secondary" size="lg">
                  View on GitHub
                </Button>
              </ButtonRow>
            </div>
            <Terminal
              className={styles.heroTerminal}
              lines={['# set this repository up, then open the web UI', '$ npx staple-cli']}
            />
          </div>
        </Section>
        <Section tone="subtle" spacing="tight">
          <CardGrid>
            <Card eyebrow="Start" title="Documentation" to="/docs" titleAs="h2">
              What staple is, where to start, and every reference page.
            </Card>
            <Card eyebrow="Reference" title="CLI" to="/docs/cli" titleAs="h2">
              Every command, flag, JSON shape and exit code.
            </Card>
            <Card eyebrow="Machines" title="Cloud sync" to="/docs/sync" titleAs="h2">
              How machines share one workspace, and what stays local.
            </Card>
          </CardGrid>
        </Section>
      </main>
    </Layout>
  );
}
