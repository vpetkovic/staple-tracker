// docs/*.md is read on GitHub as well as on the site. GitHub renders its alert
// syntax (a blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
// `[!WARNING]` or `[!CAUTION]`) as a callout; this plugin turns the same
// blockquote into a Docusaurus admonition, so one source reads well in both.
// It runs before Docusaurus' own plugins and emits the container directive the
// admonitions plugin already understands.

type Node = {type: string; value?: string; name?: string; attributes?: Record<string, string>; children?: Node[]};

// GitHub accepts the marker in any case. CAUTION is its red callout, which is
// Docusaurus' `danger`; the other four share their names.
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*(?:\n|$)/i;
const TYPE: Record<string, string> = {caution: 'danger'};

function toAdmonition(node: Node): void {
  const paragraph = node.children?.[0];
  const first = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
  if (first?.type !== 'text' || first.value === undefined) return;
  const match = MARKER.exec(first.value);
  if (!match) return;

  const inline = paragraph!.children!;
  first.value = first.value.slice(match[0].length);
  if (first.value === '') inline.shift();
  // A hard break after the marker (two trailing spaces or a backslash) would
  // open the admonition with an empty line.
  while (inline[0]?.type === 'break') inline.shift();
  // Drop the paragraph when the marker was all it held.
  if (inline.length === 0) node.children!.shift();
  // A marker with no body stays a blockquote, as GitHub shows it.
  if (node.children!.length === 0) {
    node.children = [paragraph!];
    paragraph!.children = [{type: 'text', value: match[0].trim()}];
    return;
  }

  const type = match[1]!.toLowerCase();
  node.type = 'containerDirective';
  node.name = TYPE[type] ?? type;
  node.attributes = {};
}

function walk(node: Node): void {
  if (node.type === 'blockquote') toAdmonition(node);
  node.children?.forEach(walk);
}

export default function githubAlerts() {
  return (root: Node) => walk(root);
}
