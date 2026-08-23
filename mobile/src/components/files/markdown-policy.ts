export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; rows: string[][] };

export function safeMarkdownUrl(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? trimmed : null;
}

export function markdownImageLabel(alt: string): string {
  const label = alt.trim();
  return label ? `[Image: ${label}]` : "[Image]";
}

export function hardenMarkdownInline(source: string): string {
  const withoutImages = source.replace(/!\[([^\]]*)\]\([^)]*\)/gu, (_, alt: string) =>
    markdownImageLabel(alt),
  );
  return withoutImages.replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (_, label: string, url: string) =>
    safeMarkdownUrl(url) ? `${label} (${url.trim()})` : label,
  );
}

function looksLikeTableSeparator(line: string): boolean {
  const cells = line.split("|").filter((cell) => cell.trim().length > 0);
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function tableCells(line: string): string[] {
  return line
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((cell) => hardenMarkdownInline(cell.trim()));
}

/** A bounded GFM-shaped parser used because the frozen dependency set has no Markdown package. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split("\n").slice(0, 5000);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = (lines[index] ?? "").slice(0, 2000);
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push((lines[index] ?? "").slice(0, 2000));
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        text: hardenMarkdownInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push({ kind: "quote", text: hardenMarkdownInline(line.slice(2)) });
      index += 1;
      continue;
    }
    const list = /^(\s*)([-+*]|\d+\.)\s+(.+)$/u.exec(line);
    if (list) {
      const ordered = list[2]?.endsWith(".") ?? false;
      const items: string[] = [hardenMarkdownInline(list[3] ?? "")];
      index += 1;
      while (index < lines.length) {
        const next = /^(\s*)([-+*]|\d+\.)\s+(.+)$/u.exec(lines[index] ?? "");
        if (!next || (next[2]?.endsWith(".") ?? false) !== ordered) break;
        items.push(hardenMarkdownInline(next[3] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.includes("|") && looksLikeTableSeparator(lines[index + 1] ?? "")) {
      const rows = [tableCells(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    // Raw HTML remains inert visible text, matching Markdown without an HTML plugin.
    blocks.push({ kind: "paragraph", text: hardenMarkdownInline(line) });
    index += 1;
  }
  return blocks;
}
