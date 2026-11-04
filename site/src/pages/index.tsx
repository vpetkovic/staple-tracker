import type {ComponentType, ReactNode} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Bento from '@site/src/components/landing/Bento';
import Blend from '@site/src/components/landing/Blend';

const VARIANTS: Record<string, ComponentType> = {blend: Blend, bento: Bento};

// The landing page. LANDING_VARIANT (customFields.landingVariant, set in
// docusaurus.config.ts) picks which variant `/` serves: blend, or bento in reserve.
export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const Variant = VARIANTS[String(siteConfig.customFields?.landingVariant)] ?? Blend;
  return <Variant />;
}
