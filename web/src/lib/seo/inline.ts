/*
 * The inline markup article paragraphs may carry: `code` spans and
 * [text](href) links. Deliberately tiny — a page's data should be able to
 * name a flag or cite a doc without turning into HTML. Anything else is
 * plain text, including stray brackets and backticks.
 */

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const TOKEN = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push({ kind: "text", text: source.slice(last, start) });
    if (match[1] !== undefined) {
      nodes.push({ kind: "code", text: match[1] });
    } else {
      nodes.push({ kind: "link", text: match[2], href: match[3] });
    }
    last = start + match[0].length;
  }
  if (last < source.length) nodes.push({ kind: "text", text: source.slice(last) });
  return nodes;
}

/** Every link href in a paragraph, for the catalogue's cross-link checks. */
export function inlineLinks(source: string): string[] {
  return parseInline(source).flatMap((node) => (node.kind === "link" ? [node.href] : []));
}

/** The paragraph with its markup removed — for schema text and tests. */
export function stripInline(source: string): string {
  return parseInline(source)
    .map((node) => node.text)
    .join("");
}
