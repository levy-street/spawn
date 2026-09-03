import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Frame, LINK, Section } from "@/components/grimoire/frame";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";
import { DOCS, findDoc } from "../docs";

/*
 * A design document rendered on-site from the repo's own markdown at build
 * time — the document stays canonical in docs/, and the page is a faithful
 * print of it in the pressroom's ink. Static params only.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }));
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#000000",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) return {};
  const path = `/docs/${doc.slug}`;
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: path },
    openGraph: {
      title: doc.title,
      description: doc.description,
      url: path,
      siteName: "spawnd",
      type: "article",
      images: [{ url: "/og.jpg", width: 2400, height: 1260, alt: doc.title }],
    },
  };
}

/** The repo root, from web/ at build time. */
const REPO_ROOT = join(process.cwd(), "..");

const H2 = cn(
  poster.className,
  "mt-14 mb-5 text-[clamp(24px,3.2vw,34px)] leading-[1.08] font-light text-bone uppercase [text-wrap:balance]",
);

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) notFound();
  const source = await readFile(join(REPO_ROOT, doc.file), "utf8");
  // The document's own H1 is the page's hero; drop it from the body. Links
  // to sibling documents resolve to their on-site pages when they have one
  // and become plain text when they don't — never a 404 or a private repo.
  const body = source
    .replace(/^# .*\n/, "")
    .replace(/\[([^\]]+)\]\(([A-Za-z0-9_./-]+\.md)(#[^)]*)?\)/g, (_match, text, file, hash) => {
      const target = DOCS.find((doc) => doc.file.endsWith(file.replace(/^\.\//, "")));
      return target ? `[${text}](/docs/${target.slug}${hash ?? ""})` : text;
    });
  return (
    <Frame
      crumb={{ name: "Docs", href: "/docs" }}
      pageName={doc.title}
      canonicalPath={`/docs/${doc.slug}`}
      hero={{ title: { plain: doc.title }, sub: doc.description }}
      date="2026-09-03"
      faq={[]}
      related={[
        { title: "Docs", blurb: "every design document rendered on-site", href: "/docs" },
        { title: "Security", blurb: "the trust model, plainly", href: "/security" },
        {
          title: "Guides",
          blurb: "agent guides, device guides, definitions, fixes",
          href: "/guides",
        },
      ]}
    >
      <Section>
        <article className="mx-auto w-full max-w-[72ch] text-[16px] leading-8 text-ash">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h2 className={H2}>{children}</h2>,
              h2: ({ children }) => <h2 className={H2}>{children}</h2>,
              h3: ({ children }) => (
                <h3 className="mt-10 mb-3 text-[17px] leading-7 font-semibold text-bone">
                  {children}
                </h3>
              ),
              h4: ({ children }) => (
                <h4 className="mt-8 mb-2 text-[15.5px] leading-7 font-semibold text-bone">
                  {children}
                </h4>
              ),
              p: ({ children }) => <p className="my-5">{children}</p>,
              a: ({ href, children }) => (
                <a href={href} className={LINK} rel="noreferrer">
                  {children}
                </a>
              ),
              ul: ({ children }) => <ul className="my-5 list-disc space-y-2 pl-6">{children}</ul>,
              ol: ({ children }) => (
                <ol className="my-5 list-decimal space-y-2 pl-6">{children}</ol>
              ),
              li: ({ children }) => <li className="pl-1">{children}</li>,
              strong: ({ children }) => (
                <strong className="font-semibold text-bone">{children}</strong>
              ),
              blockquote: ({ children }) => (
                <blockquote className="my-6 border-hellfire border-l-2 pl-5 text-bone italic">
                  {children}
                </blockquote>
              ),
              code: ({ children, className }) =>
                className ? (
                  <code className="font-sigil text-[13px] leading-7">{children}</code>
                ) : (
                  <code className="rounded-sm bg-char px-1.5 py-0.5 font-sigil text-[0.86em] text-bone">
                    {children}
                  </code>
                ),
              pre: ({ children }) => (
                <pre className="my-6 overflow-x-auto rounded-sm border border-line-strong bg-char px-5 py-4 text-bone">
                  {children}
                </pre>
              ),
              table: ({ children }) => (
                <div className="my-6 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-left text-[14px] leading-6">
                    {children}
                  </table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b border-line-strong py-2 pr-4 font-sigil text-[10px] font-normal tracking-[0.18em] text-ash uppercase">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border-b border-line-g py-3 pr-4 align-top">{children}</td>
              ),
              hr: () => <hr className="my-10 border-line-g" />,
            }}
          >
            {body}
          </Markdown>
        </article>
      </Section>
    </Frame>
  );
}
