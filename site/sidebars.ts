import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// One sidebar over ../docs, grouped the way docs/README.md (the docs index)
// groups the pages. The index is the source of the grouping: when a page moves
// there, move it here. Labels come from each page's front matter title (or
// sidebar_label). Contributor material lives in the repository's design/
// folder, outside ../docs, so the site never renders it.
const sidebars: SidebarsConfig = {
  docs: [
    'README',
    {
      type: 'category',
      label: 'Start here',
      collapsible: false,
      items: ['why-staple', 'getting-started', 'connect-your-agent'],
    },
    {
      type: 'category',
      label: 'Working with agents',
      collapsible: false,
      items: ['working-a-ticket', 'plans-to-tickets', 'handoff'],
    },
    {
      type: 'category',
      label: 'Planning',
      collapsible: false,
      items: ['epics-and-dependencies', 'queue', 'milestones', 'approval-gates', 'runs'],
    },
    {
      type: 'category',
      label: 'Across machines and repositories',
      collapsible: false,
      items: ['cloud-sync', 'hub'],
    },
    {
      type: 'category',
      label: 'The web UI',
      collapsible: false,
      items: ['web-ui', 'budget-and-estimates'],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsible: false,
      items: ['cli', 'mcp-tools', 'configuration', 'errors'],
    },
  ],
};

export default sidebars;
