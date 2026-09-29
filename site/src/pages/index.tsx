import type {ReactNode} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Classic from '@site/src/components/landing/Classic';
import Story from '@site/src/components/landing/Story';

// The landing page. LANDING_VARIANT (customFields.landingVariant, set in
// docusaurus.config.ts) picks which variant `/` serves; both are also at /story
// and /classic.
export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return siteConfig.customFields?.landingVariant === 'classic' ? <Classic /> : <Story />;
}
