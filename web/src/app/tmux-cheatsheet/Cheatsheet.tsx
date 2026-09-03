"use client";

import { type ReactNode, useId, useState } from "react";
import { TMUX_COMMANDS, TMUX_SECTIONS, type TmuxEntry } from "./tmux-commands";

/*
 * The cheatsheet island. Everything renders on the server — every section
 * H2, every entry — and the filter only ever hides; the first paint is the
 * whole list, so a crawler and a reader with JavaScript off see the same
 * page. Copy buttons need the clipboard, so they are the one thing that
 * does nothing without JS.
 */

const H2_CLASS =
  "scroll-mt-24 max-w-[26ch] text-[clamp(24px,3vw,32px)] leading-[1.15] font-semibold tracking-[-0.015em] text-bone [text-wrap:balance]";

/** Backticks in a note become code spans; nothing else is markup. */
function Note({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, split order is the identity
          <code key={index} className="font-sigil text-[12px] text-bone">
            {part}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text, split order is the identity
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function Keys({ keys }: { keys: string }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {keys.split(" · ").map((chord) => (
        <kbd
          key={chord}
          className="rounded bg-char px-1.5 py-0.5 font-sigil text-[12px] leading-5 text-bone ring-1 ring-line-g"
        >
          {chord}
        </kbd>
      ))}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy command"}
      onClick={() => {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          },
          () => {},
        );
      }}
      className="absolute top-2 right-2 inline-flex h-7 items-center gap-1 rounded-md px-2 font-sigil text-[11px] leading-5 text-ash ring-1 ring-line-g transition-colors hover:text-bone hover:ring-line-strong"
    >
      {copied ? (
        "copied"
      ) : (
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          width={13}
          height={13}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <title>Copy command</title>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </svg>
      )}
    </button>
  );
}

function Entry({ entry }: { entry: TmuxEntry }) {
  return (
    <li className="grid gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-6">
      <div className="min-w-0">
        <p className="text-[15px] leading-7 text-bone">{entry.task}</p>
        {entry.keys ? (
          <div className="mt-1.5">
            <Keys keys={entry.keys} />
          </div>
        ) : null}
        {entry.note ? (
          <p className="mt-1.5 text-[13px] leading-6 text-ash">
            <Note text={entry.note} />
          </p>
        ) : null}
      </div>
      <div className="relative min-w-0">
        <pre className="overflow-x-auto rounded-lg bg-char px-4 py-2.5 pr-12 font-sigil text-[13px] leading-6 whitespace-pre text-bone">
          {entry.command}
        </pre>
        <CopyButton text={entry.command} />
      </div>
    </li>
  );
}

function matches(entry: TmuxEntry, needle: string): boolean {
  if (!needle) return true;
  const hay = `${entry.task}\n${entry.command}\n${entry.keys ?? ""}\n${entry.note ?? ""}`;
  return hay.toLowerCase().includes(needle);
}

export function Cheatsheet({ children }: { children?: ReactNode }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = TMUX_COMMANDS.filter((entry) => matches(entry, needle));
  const sectionsWithHits = new Set(shown.map((entry) => entry.section));

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="sticky top-[61px] z-30 -mx-5 bg-void/90 px-5 py-3 backdrop-blur-md sm:-mx-8 sm:px-8">
        <label htmlFor={`${id}-q`} className="sr-only">
          Filter the cheatsheet
        </label>
        <div className="relative">
          <input
            id={`${id}-q`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter: kill, attach, split, scrollback, reboot…"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg bg-char px-4 py-2.5 pr-28 text-[15px] leading-6 text-bone ring-1 ring-line-g outline-none placeholder:text-ash/70 focus:ring-line-strong"
          />
          <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 font-sigil text-[11px] text-ash">
            {shown.length} of {TMUX_COMMANDS.length}
          </span>
        </div>
      </div>

      <nav aria-label="Sections" className="mt-6">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] leading-6">
          {TMUX_SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-ash underline decoration-line-strong underline-offset-4 transition-colors hover:text-bone"
              >
                {section.nav}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {children}

      {TMUX_SECTIONS.map((section) => {
        const entries = shown.filter((entry) => entry.section === section.id);
        if (needle && !sectionsWithHits.has(section.id)) return null;
        return (
          <section key={section.id} className="pt-14 sm:pt-20">
            <h2 id={section.id} className={H2_CLASS}>
              {section.title}
            </h2>
            <p className="mt-4 max-w-[60ch] text-[15px] leading-7 text-ash">{section.lead}</p>
            <ul className="mt-6 divide-y divide-line-g">
              {entries.map((entry) => (
                <Entry key={`${section.id}:${entry.task}`} entry={entry} />
              ))}
            </ul>
          </section>
        );
      })}

      {needle && shown.length === 0 ? (
        <p className="pt-14 text-[15px] leading-7 text-ash">
          Nothing matches “{query}”. Try the verb — kill, attach, split, resize, copy — or the
          message tmux printed.
        </p>
      ) : null}
    </div>
  );
}
