import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// One sidebar over ../docs, grouped the way docs/README.md (the docs index)
// groups the pages. The index is the source of the grouping: when a page moves
// there, move it here. Labels come from each page's front matter title.
const sidebars: SidebarsConfig = {
  docs: [
    'README',
    {
      type: 'category',
      label: 'Getting started',
      // The category is the page: one "Getting started" in the sidebar and
      // in the breadcrumbs, not a category and a page of the same name.
      link: {type: 'doc', id: 'getting-started'},
      collapsible: false,
      items: ['packaging', 'web-ui', 'configuration'],
    },
    {
      type: 'category',
      label: 'Working with agents',
      collapsible: false,
      items: ['agents', 'semantics'],
    },
    {
      type: 'category',
      label: 'Planning',
      collapsible: false,
      items: ['queue', 'milestones', 'runs'],
    },
    {
      type: 'category',
      label: 'Sync and continuity',
      collapsible: false,
      items: ['sync', 'continuity'],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsible: false,
      items: ['cli', 'execution-telemetry', 'timing-semantics'],
    },
    {
      type: 'category',
      label: 'Internals',
      collapsible: false,
      items: ['architecture', 'migration'],
    },
  ],
};

export default sidebars;
