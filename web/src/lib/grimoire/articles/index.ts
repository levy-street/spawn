import type { ArticleEntry, HubEntry } from "../types";
import { CLAUDE_CODE, CLAUDE_CODE_HUB } from "./claude-code";
import { CLAUDE_CODE_REFERENCE } from "./claude-code-reference";
import { CODEX, CODEX_HUB } from "./codex";
import { DEFINITIONS } from "./definitions";
import { FIXES_AND_ESSAYS } from "./fixes-and-essays";
import { MAC_AND_VSCODE } from "./mac-and-vscode";
import { OPEN_AGENTS } from "./open-agents";
import { PHONE_SSH } from "./phone-ssh";
import { ROUNDUPS } from "./roundups";

/*
 * Article pages, one file per keyword cluster of the grimoire. Every entry
 * is pure data on the article template; adding a page is one entry in the
 * cluster file it belongs to. Clusters that own a pillar hub export it too.
 */

export const ARTICLES: ArticleEntry[] = [
  ...CLAUDE_CODE,
  ...CLAUDE_CODE_REFERENCE,
  ...CODEX,
  ...OPEN_AGENTS,
  ...DEFINITIONS,
  ...PHONE_SSH,
  ...MAC_AND_VSCODE,
  ...ROUNDUPS,
  ...FIXES_AND_ESSAYS,
];

export const ARTICLE_HUBS: HubEntry[] = [...CLAUDE_CODE_HUB, ...CODEX_HUB];
