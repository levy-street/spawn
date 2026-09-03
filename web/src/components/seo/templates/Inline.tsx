import Link from "next/link";
import { JOB_LINK } from "@/components/seo/templates/link";
import { parseInline } from "@/lib/seo/inline";

/**
 * Renders an article paragraph's inline markup: code spans in the sigil
 * mono, site-relative links through next/link, external links opening in a
 * new tab. Server-rendered; no client JS.
 */
export function Inline({ text }: { text: string }) {
  const nodes = parseInline(text);
  // Keys by character offset: unique among siblings by construction.
  let offset = 0;
  return (
    <>
      {nodes.map((node) => {
        const key = `${offset}-${node.kind}`;
        offset += node.text.length + (node.kind === "link" ? node.href.length : 0);
        if (node.kind === "code") {
          return (
            <code
              key={key}
              className="rounded bg-char px-1.5 py-0.5 font-sigil text-[0.86em] text-bone"
            >
              {node.text}
            </code>
          );
        }
        if (node.kind === "link") {
          if (node.href.startsWith("/")) {
            return (
              <Link key={key} prefetch={false} href={node.href} className={JOB_LINK}>
                {node.text}
              </Link>
            );
          }
          return (
            <a key={key} href={node.href} target="_blank" rel="noreferrer" className={JOB_LINK}>
              {node.text}
            </a>
          );
        }
        return node.text;
      })}
    </>
  );
}
