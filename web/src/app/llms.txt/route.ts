/*
 * /llms.txt — what spawnd is, in one paragraph, for AI assistants and
 * crawlers that read this convention. Copy stays consistent with the site's
 * shipped description and the claims in docs/TRUST.md; the page list names
 * the hubs, which link everything else.
 */

const SITE = "https://spawnd.dev";

const BODY = `# SPAWN D

> The open-source control plane for CLI coding agents. A daemon on every host you own — summon your agents, reach them from any browser, and the server that connects you never hears a word.

spawnd runs coding agents (Claude Code, Codex, OpenCode, Aider, or any CLI) as persistent terminal sessions on machines you own. One daemon per host dials out, so nothing listens and no ports open. Any browser — a phone's included, installed as a web app — becomes the console: workspaces per project, live sessions across hosts, attention cues when an agent waits on a yes. Your browser talks to each daemon peer-to-peer, end-to-end encrypted; when a relay is unavoidable it forwards ciphertext it cannot decrypt. Agents authenticate on the host as they always do; spawnd holds no provider credentials. Open source, MIT/Apache-2.0. Daemon for macOS and Linux.

## Start here

- [Home](${SITE}/): what it is and the one-line install
- [Security](${SITE}/security): the trust model, plainly
- [Download](${SITE}/download): the daemon, per platform
- [Docs](${SITE}/docs): design documents rendered on-site, starting with the session architecture

## Guides and references

- [Guides hub](${SITE}/guides): agent guides, device guides, definitions, fixes, tools
- [Claude Code](${SITE}/claude-code): plans, settings, commands, remote use
- [Codex CLI](${SITE}/codex): the complete guide
- [Claude plan calculator](${SITE}/claude-plan-calculator): Pro vs Max vs API
- [tmux cheatsheet](${SITE}/tmux-cheatsheet): sessions, windows, panes, fixes

## Machine-readable

- [Sitemap](${SITE}/sitemap.xml)
`;

export const dynamic = "force-static";

export function GET() {
  return new Response(BODY, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
