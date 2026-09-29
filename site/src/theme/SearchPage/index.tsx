import type {ComponentProps, ReactNode} from 'react';
import OriginalSearchPage from '@theme-original/SearchPage';
import {WrapInMain} from '@site/src/lib/wrapInMain';

// The search plugin's results page renders its content in a plain <div>: the layout
// puts it in the page's <main> landmark, as every other page has one.
export default function SearchPage(props: ComponentProps<typeof OriginalSearchPage>): ReactNode {
  return (
    <WrapInMain.Provider value>
      <OriginalSearchPage {...props} />
    </WrapInMain.Provider>
  );
}
