import {useContext, type ComponentProps, type ReactNode} from 'react';
import OriginalLayout from '@theme-original/Layout';
import {WrapInMain} from '@site/src/lib/wrapInMain';

// The classic layout, plus a <main> around the content of a page that asks for one.

export default function Layout({children, ...props}: ComponentProps<typeof OriginalLayout>): ReactNode {
  const wrap = useContext(WrapInMain);
  return <OriginalLayout {...props}>{wrap ? <main>{children}</main> : children}</OriginalLayout>;
}
