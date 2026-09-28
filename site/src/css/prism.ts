import type {PrismTheme} from 'prism-react-renderer';

// Syntax colours for code blocks. Every colour is a token from tokens.css, so the
// one theme serves light and dark: the tokens switch with the colour mode.
const token = (name: string) => `var(--st-syntax-${name})`;

export const syntaxTheme: PrismTheme = {
  plain: {color: 'var(--st-code-fg)', backgroundColor: 'var(--st-code-bg)'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: token('comment'), fontStyle: 'italic'}},
    {types: ['punctuation', 'operator'], style: {color: token('punctuation')}},
    {types: ['keyword', 'atrule', 'selector', 'important'], style: {color: token('keyword')}},
    {types: ['string', 'char', 'attr-value', 'regex', 'inserted'], style: {color: token('string')}},
    {types: ['function', 'class-name', 'builtin'], style: {color: token('function')}},
    {types: ['number', 'boolean', 'constant', 'symbol', 'deleted'], style: {color: token('number')}},
    {types: ['property', 'tag', 'attr-name', 'variable', 'parameter'], style: {color: token('property')}},
  ],
};
