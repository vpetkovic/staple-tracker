import type {ComponentType, ReactNode} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Bento from '@site/src/components/landing/Bento';
import Classic from '@site/src/components/landing/Classic';
import Story from '@site/src/components/landing/Story';
import Walkthrough from '@site/src/components/landing/Walkthrough';

const VARIANTS: Record<string, ComponentType> = {story: Story, classic: Classic, bento: Bento, walkthrough: Walkthrough};

// The landing page. LANDING_VARIANT (customFields.landingVariant, set in
// docusaurus.config.ts) picks which variant `/` serves; each is also at its own
// address (/story, /classic, /bento, /walkthrough).
export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const Variant = VARIANTS[String(siteConfig.customFields?.landingVariant)] ?? Story;
  return <Variant />;
}
