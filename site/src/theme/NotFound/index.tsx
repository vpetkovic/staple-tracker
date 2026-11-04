import type {ReactNode} from 'react';
import {PageMetadata} from '@docusaurus/theme-common';
import Layout from '@theme/Layout';
import NotFoundContent from '@theme/NotFound/Content';

// The 404 page, titled in sentence case like every other page.
export default function NotFound(): ReactNode {
  return (
    <>
      <PageMetadata title="Page not found" />
      <Layout>
        <NotFoundContent />
      </Layout>
    </>
  );
}
