import {createContext} from 'react';

// Set by a page whose own content has no <main> (the search plugin's results page),
// so the layout (src/theme/Layout) supplies the landmark around it.
export const WrapInMain = createContext(false);
