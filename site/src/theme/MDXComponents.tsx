import type {ComponentProps, ReactNode} from 'react';
import MDXComponents from '@theme-original/MDXComponents';

// Markdown tables sit in a focusable scroll container, so a table wider than the
// column scrolls on its own and keyboard users can scroll it too.
function Table(props: ComponentProps<'table'>): ReactNode {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table {...props} />
    </div>
  );
}

export default {...MDXComponents, table: Table};
