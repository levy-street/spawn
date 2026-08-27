import { cn } from "@/lib/utils";

/*
 * The job template's signature section: the workspace grid, mid-shift. A pure
 * CSS rendering of the product's core surface — a packed grid of live terminal
 * tiles across several hosts — with the fleet caught at its telling moments:
 * one agent asking permission, one streaming a diff, one grinding tests.
 * Server markup only; the sole motion is `animate-pulse` on cursors and the
 * waiting dot, which the global reduced-motion rule flattens.
 */

export type VignetteLine =
  | { t: "cmd"; text: string; cursor?: boolean }
  | { t: "out"; text: string; cursor?: boolean }
  | { t: "dim"; text: string; cursor?: boolean }
  | { t: "hot"; text: string; cursor?: boolean }
  | { t: "add"; text: string }
  | { t: "del"; text: string }
  | { t: "pick"; selected: string; rest: string };

export interface VignetteTile {
  agent: string;
  host: string;
  dir: string;
  status: "waiting" | "live" | "done";
  /** Tiles beyond the first three hide below `sm` to keep the phone view short. */
  mobile?: boolean;
  lines: VignetteLine[];
}

/** The flagship fleet: six sessions, three hosts, one grid. */
export const PARALLEL_FLEET: VignetteTile[] = [
  {
    agent: "claude",
    host: "dream",
    dir: "~/api.wt/auth",
    status: "waiting",
    mobile: true,
    lines: [
      { t: "cmd", text: "claude" },
      { t: "hot", text: "✻ Reworking the auth boundary…" },
      { t: "out", text: "● Edit(src/auth/refresh.ts)" },
      { t: "dim", text: "  …and 11 more files" },
      { t: "out", text: "Do you want to make these edits?" },
      { t: "pick", selected: "1. Yes", rest: "2. Yes, allow all  3. No" },
    ],
  },
  {
    agent: "codex",
    host: "rig",
    dir: "~/api.wt/importer",
    status: "live",
    mobile: true,
    lines: [
      { t: "cmd", text: "codex" },
      { t: "hot", text: "▌ rewriting the loader's chunk loop" },
      { t: "del", text: "-  rows = reader.read_all()" },
      { t: "del", text: "-  sink.write_sync(rows)" },
      { t: "add", text: "+  for batch in reader.batches(64):" },
      { t: "add", text: "+      await sink.write(batch)" },
      { t: "dim", text: "src/import/loader.py · +38 −114", cursor: true },
    ],
  },
  {
    agent: "claude",
    host: "rig",
    dir: "~/api.wt/perf",
    status: "live",
    mobile: true,
    lines: [
      { t: "cmd", text: "claude" },
      { t: "hot", text: "✻ Chasing the flaky eviction test…" },
      { t: "cmd", text: "bun test cache" },
      { t: "out", text: "✓ evicts oldest under pressure" },
      { t: "dim", text: "✗ survives concurrent flush" },
      { t: "out", text: "211 pass · 1 fail · rerunning", cursor: true },
    ],
  },
  {
    agent: "aider",
    host: "pi",
    dir: "~/blog",
    status: "done",
    lines: [
      { t: "cmd", text: "aider" },
      { t: "out", text: "Applied edit to posts/render.ts" },
      { t: "dim", text: "Commit a41f2c9 fix: escape inline code" },
      { t: "cmd", text: "" },
    ],
  },
  {
    agent: "opencode",
    host: "dream",
    dir: "~/api.wt/docs",
    status: "live",
    lines: [
      { t: "cmd", text: "opencode" },
      { t: "dim", text: "> regenerate the API reference" },
      { t: "out", text: "read src/routes/workspaces.ts" },
      { t: "out", text: "writing docs/api/workspaces.md", cursor: true },
    ],
  },
  {
    agent: "shell",
    host: "dream",
    dir: "~/api",
    status: "live",
    lines: [
      { t: "cmd", text: "git worktree list" },
      { t: "dim", text: "~/api             0b0454e [master]" },
      { t: "dim", text: "~/api.wt/auth     9c21d7e [agents/auth]" },
      { t: "dim", text: "~/api.wt/importer 77aa310 [agents/import]" },
      { t: "dim", text: "~/api.wt/perf     41d03be [agents/perf]" },
      { t: "cmd", text: "", cursor: true },
    ],
  },
];

function Cursor() {
  return (
    <span aria-hidden className="animate-pulse text-bone">
      ▍
    </span>
  );
}

function Line({ line }: { line: VignetteLine }) {
  const base = "overflow-hidden text-ellipsis whitespace-pre";
  switch (line.t) {
    case "cmd":
      return (
        <div className={base}>
          <span className="text-ember">$ </span>
          <span className="text-bone">{line.text}</span>
          {line.cursor ? <Cursor /> : null}
        </div>
      );
    case "out":
      return (
        <div className={cn(base, "text-bone/90")}>
          {line.text}
          {line.cursor ? <Cursor /> : null}
        </div>
      );
    case "dim":
      return (
        <div className={cn(base, "text-ash")}>
          {line.text}
          {line.cursor ? <Cursor /> : null}
        </div>
      );
    case "hot":
      return (
        <div className={cn(base, "text-ember")}>
          {line.text}
          {line.cursor ? <Cursor /> : null}
        </div>
      );
    case "add":
      return <div className={cn(base, "text-ember")}>{line.text}</div>;
    case "del":
      return <div className={cn(base, "text-ash/60")}>{line.text}</div>;
    case "pick":
      return (
        <div className={base}>
          <span className="text-ember">❯ </span>
          <span className="bg-bone px-1 text-void">{line.selected}</span>
          <span className="text-ash"> {line.rest}</span>
        </div>
      );
  }
}

function TileBadge({ status }: { status: VignetteTile["status"] }) {
  if (status === "waiting") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-ember/40 bg-ember/10 px-1.5 py-0.5 text-[9px] tracking-[0.14em] text-ember">
        <span aria-hidden className="size-1 animate-pulse rounded-full bg-ember" />
        waiting for you
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="inline-flex shrink-0 items-center rounded-sm border border-line-strong px-1.5 py-0.5 text-[9px] tracking-[0.14em] text-ash">
        finished
      </span>
    );
  }
  return null;
}

function Tile({ tile }: { tile: VignetteTile }) {
  const waiting = tile.status === "waiting";
  return (
    <div
      className={cn(
        "relative min-h-[196px] flex-col bg-void",
        tile.mobile ? "flex" : "hidden sm:flex",
        waiting && "z-[1] shadow-[inset_0_0_0_1px_rgba(255,69,58,0.45)]",
      )}
    >
      {waiting ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_75%_55%_at_50%_100%,rgba(255,69,58,0.09),transparent_70%)]"
        />
      ) : null}
      <div className="flex items-center gap-2 border-line-g border-b bg-char/60 px-3.5 py-2 font-sigil text-[10px] tracking-[0.14em] uppercase">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            waiting && "animate-pulse bg-ember",
            tile.status === "live" && "bg-ember",
            tile.status === "done" && "bg-ash/50",
          )}
        />
        <span className="shrink-0 text-bone">{tile.agent}</span>
        <span className="shrink-0 text-ash">· {tile.host}</span>
        <TileBadge status={tile.status} />
        <span className="ml-auto truncate text-ash/80 lowercase">{tile.dir}</span>
      </div>
      <div className="relative flex-1 px-3.5 py-3 font-sigil text-[11px] leading-[1.85]">
        {tile.lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static vignette data, never reordered
          <Line key={index} line={line} />
        ))}
      </div>
    </div>
  );
}

export function WorkspaceGridVignette({
  name = "the-fleet",
  tiles = PARALLEL_FLEET,
  className,
}: {
  name?: string;
  tiles?: VignetteTile[];
  className?: string;
}) {
  const hosts: { host: string; count: number }[] = [];
  for (const tile of tiles) {
    const entry = hosts.find((h) => h.host === tile.host);
    if (entry) entry.count += 1;
    else hosts.push({ host: tile.host, count: 1 });
  }
  return (
    <figure className={cn("min-w-0", className)}>
      <div className="overflow-hidden rounded-sm border border-line-strong bg-void shadow-[0_40px_120px_-40px_rgba(225,30,21,0.25)]">
        <div className="flex items-center justify-between gap-4 border-line-g border-b bg-char px-4 py-2.5">
          <span className="flex items-center gap-3">
            <span aria-hidden className="grid shrink-0 grid-cols-2 gap-[3px]">
              <span className="size-[5px] bg-hellfire" />
              <span className="size-[5px] bg-hellfire/50" />
              <span className="size-[5px] bg-hellfire/50" />
              <span className="size-[5px] bg-hellfire" />
            </span>
            <span className="font-sigil text-[11px] tracking-[0.22em] uppercase">
              <span className="text-ash">workspace / </span>
              <span className="text-bone">{name}</span>
            </span>
          </span>
          <span className="flex items-center gap-4">
            {hosts.map((h) => (
              <span
                key={h.host}
                className="hidden items-center gap-1.5 font-sigil text-[10px] tracking-[0.18em] text-ash uppercase sm:inline-flex"
              >
                <span aria-hidden className="size-1.5 rounded-full bg-ember/80" />
                {h.host} · {h.count}
              </span>
            ))}
            <span className="font-sigil text-[10px] tracking-[0.18em] text-ash uppercase sm:hidden">
              {tiles.length} sessions · {hosts.length} hosts
            </span>
          </span>
        </div>
        <div className="grid grid-cols-1 gap-px bg-line-g sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile) => (
            <Tile key={`${tile.host}:${tile.dir}`} tile={tile} />
          ))}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-col gap-1 px-1 font-sigil text-[10px] tracking-[0.16em] text-ash uppercase sm:flex-row sm:items-center sm:justify-between">
        <span>The workspace, as it ships — every tile a live PTY on the host that owns it</span>
        <span className="hidden text-ash/70 sm:inline">
          terminal bytes: browser ⇄ daemon · e2e encrypted
        </span>
      </figcaption>
    </figure>
  );
}
