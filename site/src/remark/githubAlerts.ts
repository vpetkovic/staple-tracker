// docs/*.md is read on GitHub as well as on the site. GitHub renders its alert
// syntax (a blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
// `[!WARNING]` or `[!CAUTION]`) as a callout; this plugin turns the same
// blockquote into a Docusaurus admonition, so one source reads well in both.
// It runs before Docusaurus' own plugins and emits the container directive the
// admonitions plugin already understands.

type Node = {type: string; value?: string; name?: string; attributes?: Record<string, string>; children?: Node[]};

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*(?:\n|$)/;

function toAdmonition(node: Node): void {
  const paragraph = node.children?.[0];
  const first = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
  if (first?.type !== 'text' || first.value === undefined) return;
  const match = MARKER.exec(first.value);
  if (!match) return;

  first.value = first.value.slice(match[0].length);
  if (first.value === '') paragraph!.children!.shift();
  // A soft line break after the marker leaves the paragraph's text starting
  // on the next line; drop the paragraph when the marker was all it held.
  if (paragraph!.children!.length === 0) node.children!.shift();

  node.type = 'containerDirective';
  node.name = match[1]!.toLowerCase();
  node.attributes = {};
}

function walk(node: Node): void {
  if (node.type === 'blockquote') toAdmonition(node);
  node.children?.forEach(walk);
}

export default function githubAlerts() {
  return (root: Node) => walk(root);
}
