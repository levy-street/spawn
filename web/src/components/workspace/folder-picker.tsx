"use client";

import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ellipsis,
  Eye,
  FolderPlus,
  Home,
  LoaderCircle,
  Search,
  WifiOff,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { type MenuPlacement, measureMenu } from "@/components/ui/menu-position";
import { useHostControl } from "@/hooks/useHostControl";
import type { Host } from "@/lib/api";
import { HostControlError } from "@/lib/hostControl";
import {
  isAbsolutePath,
  isValidPathLeafName,
  normalizeCwdForHost,
  pathFlavorForHostOS,
  pathsEqual,
} from "@/lib/paths";
import { cn } from "@/lib/utils";
import { FolderColumn, type FolderColumnEmpty } from "./folder-picker-column";
import { CrumbDrillMenu } from "./folder-picker-crumbs";
import {
  breadcrumbParts,
  folderColumns,
  isWithinHome,
  joinDirectory,
  listAllEntries,
  parentWithinHome,
  placePickerPanel,
  visibleDirectories,
} from "./folder-picker-helpers";

const SHOW_HIDDEN_KEY = "spawn.folderPicker.showHidden";

/**
 * One column's width. Handed to the columns as `--picker-column` so this stays
 * the single source of truth for it: the panel is sized to hold exactly
 * `VISIBLE_COLUMNS` of them, and a deeper trail scrolls back through that
 * frame rather than widening the panel to fit.
 */
const COLUMN_WIDTH = 224;
const VISIBLE_COLUMNS = 2;
/** p-3 either side of the body, plus the strip's own 1px border. */
const PANEL_CHROME = 26;

/** The panel's preferred size; the placement caps it to the room available. */
const PANEL_WIDTH = COLUMN_WIDTH * VISIBLE_COLUMNS + PANEL_CHROME;
const PANEL_HEIGHT = 440;

/**
 * Bring the trail's selected row into view *vertically*, and only vertically.
 *
 * `scrollIntoView` cannot do this: `inline` defaults to "nearest" whatever
 * `block` is set to, and it walks every scrollable ancestor — so a call meant
 * to nudge one row down its own column also scrolled the column strip
 * sideways, instantly, cancelling the smooth horizontal scroll that had just
 * been started a line above. The visible symptom was a picker whose reveal ran
 * exactly one drill behind: opening a folder scrolled to where the *previous*
 * one had wanted to be, because the row it had just highlighted was what the
 * strip ended up chasing.
 */
function revealSelectedRow(row: HTMLElement | null): void {
  const column = row?.closest<HTMLElement>('[role="listbox"]');
  if (!row || !column) return;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < column.scrollTop) column.scrollTop = top;
  else if (bottom > column.scrollTop + column.clientHeight) {
    column.scrollTop = bottom - column.clientHeight;
  }
}

/**
 * The folder picker: a Finder column browser in an anchored dropdown.
 *
 * Choosing a folder does not replace the list: its own column opens to the
 * right of the one it came from, so the trail you walked stays on screen and
 * stepping back is a glance left rather than a ".." round trip. The columns
 * are derived from the selected path rather than accumulated as you click, so
 * a crumb jump, the drill menu, an arrow key and a stale saved cwd all rebuild
 * the same trail — there is no history to fall out of sync with the path.
 */
export function FolderPicker({
  open,
  host,
  initialPath,
  anchorRef,
  onBack,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  host: Host | null;
  /** The folder already in effect: the trail opens expanded to it. */
  initialPath?: string | null;
  /** The control the panel hangs off. Centred in the viewport without one. */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Return to the step that led here — the host cascade, the host dialog.
   * Omitted when the picker is the whole interaction, which is when a back
   * button would have nowhere to go.
   */
  onBack?: () => void;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const { client, retry, state } = useHostControl(
    host?.id ?? null,
    open && host?.status === "online",
  );
  const pathFlavor = pathFlavorForHostOS(host?.os);
  const [path, setPath] = useState(initialPath || "~");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const stripRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // False until the strip has been parked once, which separates "opened at a
  // folder" from "drilled into one" — the two want opposite scroll positions.
  const settled = useRef(false);
  /**
   * Bumped by every navigation, so the reveal is driven by the act rather than
   * by the path it produced. Pressing the folder you are already in is a
   * request to see inside it — the most natural way to ask, from the column
   * where it sits highlighted — and that leaves the path exactly as it was, so
   * a reveal keyed on the path alone would answer it with nothing at all.
   */
  const [revealNonce, setRevealNonce] = useState(0);
  const leafColumnRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<MenuPlacement | null>(null);

  // Read after mount rather than in the initial state so a server render and
  // the first client render agree.
  useEffect(() => {
    setShowHidden(window.localStorage.getItem(SHOW_HIDDEN_KEY) === "true");
  }, []);

  const toggleHidden = () => {
    setShowHidden((value) => {
      window.localStorage.setItem(SHOW_HIDDEN_KEY, String(!value));
      return !value;
    });
  };

  const homeQ = useQuery({
    queryKey: ["host-home", host?.id],
    queryFn: () => client!.home(),
    enabled: open && state === "ready" && client !== null,
    staleTime: 5 * 60_000,
  });
  const homeDir = homeQ.data?.home_dir ?? null;

  // Resolve whatever we were opened at — "~", or a cwd carried in from a
  // session or template — the moment the home directory is known, and clamp it
  // into home. A saved path from another machine must not strand the picker
  // above the root the host will serve.
  useEffect(() => {
    if (!open || !homeDir) return;
    const next = normalizeCwdForHost(path, homeDir, pathFlavor);
    const clamped = isWithinHome(next, homeDir, pathFlavor)
      ? next
      : normalizeCwdForHost("~", homeDir, pathFlavor);
    if (clamped !== path) setPath(clamped);
  }, [homeDir, open, path, pathFlavor]);

  const fallbackRoot = pathFlavor === "windows" ? "\\" : "/";
  const resolvedPath =
    homeDir && path.startsWith("~") ? normalizeCwdForHost(path, homeDir, pathFlavor) : path;
  const listedPath = isAbsolutePath(resolvedPath, pathFlavor)
    ? resolvedPath
    : (homeDir ?? fallbackRoot);
  const breadcrumbs = breadcrumbParts(listedPath, homeDir ?? fallbackRoot, pathFlavor);
  const columns = folderColumns(listedPath, homeDir ?? fallbackRoot, pathFlavor);
  const leafIndex = columns.length - 1;
  // The column holding the current selection: one left of the trailing column,
  // and absent entirely at the home root where nothing is selected yet.
  const trailIndex = columns.length - 2;

  const columnQueries = useQueries({
    queries: columns.map((column) => ({
      queryKey: ["host-folders", host?.id, column.path],
      queryFn: () => listAllEntries((cursor) => client!.listPage(column.path, cursor)),
      enabled:
        open &&
        state === "ready" &&
        client !== null &&
        Boolean(homeDir) &&
        isAbsolutePath(column.path, pathFlavor),
      staleTime: 5_000,
    })),
  });

  // Not memoized: the query results are a fresh array every render anyway, and
  // a handful of short lists costs less than the key that would guard it.
  const columnEntries = columns.map((_, index) =>
    visibleDirectories(columnQueries[index]?.data?.entries, {
      // The filter narrows the column you are browsing; the trail behind it
      // has to stay whole, or the folder you already picked would vanish from
      // the list that shows where you are.
      filter: index === leafIndex ? filter : "",
      showHidden,
    }),
  );

  // Every jump — crumb, row, arrow key, drill menu — lands inside home or not
  // at all. The host refuses anything above it, so clamping here keeps a stale
  // path (a saved cwd from another machine, say) from stranding the picker on
  // an error screen with no way down.
  const navigate = (value: string) => {
    if (!homeDir) return;
    const next = normalizeCwdForHost(value, homeDir, pathFlavor);
    setPath(
      isWithinHome(next, homeDir, pathFlavor)
        ? next
        : normalizeCwdForHost("~", homeDir, pathFlavor),
    );
    setFilter("");
    setRevealNonce((value) => value + 1);
  };

  // Anchored like a menu, with the same viewport-aware placement: the panel is
  // large, so which side it opens to matters more here than anywhere else.
  // `placePickerPanel` centres it without an anchor — opened from a cascade
  // that has already closed, so there is no control left to hang off — and
  // over an anchor too big to leave it a usable side, which is what the
  // grid's "Add a window" opening is: an area, not a control.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const place = () => {
      const { width, height } = measureMenu(panelRef.current, PANEL_WIDTH);
      setCoords(
        placePickerPanel({
          anchor: anchorRef?.current?.getBoundingClientRect() ?? null,
          width,
          height,
          preferredHeight: PANEL_HEIGHT,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    const observer = new ResizeObserver(place);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef]);

  // Light dismiss. The breadcrumb drill and options menus portal to the body,
  // so a click or an Escape inside one belongs to that menu, not to the picker.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[role='menu']")) return;
      if (target && panelRef.current?.contains(target)) return;
      if (target && anchorRef?.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("[role='menu']")) return;
      // The filter is the innermost layer: Escape folds it away first, and
      // only a second Escape closes the picker.
      if (searchOpen) {
        setSearchOpen(false);
        setFilter("");
        return;
      }
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange, anchorRef, searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [searchOpen]);

  // Focus the column you landed in, so the arrow keys work without a click
  // first. The filter box is one Tab away for anyone who would rather type.
  // Not until the home directory lands: the columns are rebuilt (re-keyed)
  // then, so an earlier focus sits on an element about to unmount and falls
  // back to the body. preventScroll because the parking effect below owns the
  // strip's position — a focus scroll would drag the leaf into frame when the
  // park deliberately leaves it one scroll further right.
  useEffect(() => {
    if (!open || !homeDir) return;
    const id = requestAnimationFrame(() => leafColumnRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open, homeDir]);

  // Park the strip as the trail changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listedPath and revealNonce are the changes being tracked
  useEffect(() => {
    if (!open) {
      settled.current = false;
      return;
    }
    // Nothing worth parking against until the host reports its home directory.
    // The trail is measured from there, and until it lands the columns are the
    // raw filesystem path — a longer trail, so parking now would aim at the
    // wrong column and never correct itself: listedPath does not change when
    // the home directory arrives, so this effect would not run again.
    if (!homeDir) return;
    const id = requestAnimationFrame(() => {
      const strip = stripRef.current;
      if (strip) {
        // Opening at a folder several levels down lands on the selection in
        // context — the column it sits in, hard against the right edge — with
        // its own children one scroll further right for anyone who wants them.
        // Every move after that is a drill-in, where revealing the column you
        // just opened is the whole point, so those run to the end instead.
        const left = settled.current
          ? strip.scrollWidth
          : Math.max(0, (trailIndex + 1) * COLUMN_WIDTH - strip.clientWidth);
        strip.scrollTo({ left, behavior: settled.current ? "smooth" : "auto" });
        settled.current = true;
      }
      revealSelectedRow(selectedRef.current);
    });
    return () => cancelAnimationFrame(id);
  }, [open, homeDir, listedPath, revealNonce]);

  const mkdirM = useMutation({
    mutationFn: (name: string) => client!.mkdir(joinDirectory(listedPath, name, pathFlavor)),
    onSuccess: () => {
      setCreatingFolder(false);
      setFolderName("");
      // The new folder lands inside the selection, which is the trailing
      // column — that is the one that has to re-list.
      void columnQueries[leafIndex]?.refetch();
    },
  });

  const submitFolder = () => {
    const name = pathFlavor === "windows" ? folderName : folderName.trim();
    if (!isValidPathLeafName(name, pathFlavor)) return;
    mkdirM.mutate(name);
  };

  // Confirming the folder that was already in effect is a no-op, not a change:
  // calling onSelect would re-run whatever the caller does with a new folder —
  // type a `cd` into a live shell, write a workspace setting — and in the shell
  // case that means an "interrupt the agent?" prompt for a move to where the
  // window already is. Closing is the whole of the right answer.
  const startedAt =
    homeDir && initialPath ? normalizeCwdForHost(initialPath, homeDir, pathFlavor) : null;
  const commit = () => {
    if (startedAt === null || !pathsEqual(startedAt, listedPath, pathFlavor)) onSelect(listedPath);
    onOpenChange(false);
  };

  // Null at the home root: there is no rung above it.
  const parentPath = homeDir === null ? null : parentWithinHome(listedPath, homeDir, pathFlavor);
  const selectable =
    state === "ready" && homeDir !== null && isWithinHome(listedPath, homeDir, pathFlavor);
  const connectionFailed = state === "error" || state === "unauthorized" || state === "closed";
  const homeFailed = state === "ready" && homeQ.isError;
  const pickerUnavailable = connectionFailed || homeFailed;
  const connecting = !pickerUnavailable && (state !== "ready" || homeQ.isLoading);
  const chrome = !pickerUnavailable && (state !== "ready" || homeQ.isLoading);

  const retryPicker = () => {
    if (connectionFailed) retry();
    else void homeQ.refetch();
  };

  const failureDetail = homeFailed
    ? listErrorMessage(homeQ.error)
    : state === "unauthorized"
      ? "The host refused this browser’s credentials."
      : state === "closed"
        ? "The folder connection closed before it was ready."
        : "The secure folder channel could not be established.";

  /** Move the selection among its siblings — the column view's up/down. */
  const step = (delta: 1 | -1) => {
    const siblings = columnEntries[Math.max(0, trailIndex)] ?? [];
    if (siblings.length === 0) return;
    const current =
      trailIndex < 0
        ? -1
        : siblings.findIndex((entry) => pathsEqual(entry.path, listedPath, pathFlavor));
    const next =
      current < 0
        ? delta === 1
          ? 0
          : siblings.length - 1
        : Math.min(siblings.length - 1, Math.max(0, current + delta));
    const target = siblings[next];
    if (target) navigate(target.path);
  };

  /**
   * Why this column has nothing in it, and the way out of that. Only the
   * trailing column offers "New folder": mkdir lands inside the selection, so
   * on an ancestor the button would create the folder somewhere else.
   */
  const emptyState = (index: number, hiddenCount: number): FolderColumnEmpty => {
    if (index === leafIndex && filter) {
      return {
        icon: <Search />,
        title: "No matches",
        body: `Nothing here matches “${filter}”.`,
        action: (
          <Button type="button" variant="outline" size="sm" onClick={() => setFilter("")}>
            Clear filter
          </Button>
        ),
      };
    }
    if (hiddenCount > 0) {
      return {
        icon: <Eye />,
        title: `Only hidden folder${hiddenCount === 1 ? "" : "s"} here`,
        body: `This folder holds ${hiddenCount === 1 ? "one folder whose name starts" : `${hiddenCount} folders whose names start`} with a dot.`,
        action: (
          <Button type="button" variant="outline" size="sm" onClick={toggleHidden}>
            Show hidden folders
          </Button>
        ),
      };
    }
    return {
      icon: <FolderPlus />,
      title: "No subfolders",
      body:
        index === leafIndex
          ? "Nothing to open from here — make a folder, or select this one as it is."
          : undefined,
      action:
        index === leafIndex ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!client || state !== "ready"}
            onClick={() => setCreatingFolder(true)}
          >
            <FolderPlus className="size-4" aria-hidden />
            New folder
          </Button>
        ) : undefined,
    };
  };

  /**
   * Trail-wide arrow navigation. It lives on the columns (each a listbox)
   * rather than the scroll strip, and row buttons bubble their keys up to
   * whichever column holds focus.
   */
  const onColumnKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const first = columnEntries[leafIndex]?.[0];
      if (first) navigate(first.path);
    } else if (event.key === "ArrowLeft" || (event.key === "Backspace" && filter === "")) {
      event.preventDefault();
      if (parentPath !== null) navigate(parentPath);
    } else if (event.key === "Enter" && selectable) {
      event.preventDefault();
      commit();
    }
  };

  // Typed rather than cast: --picker-column is a real custom property, and
  // CSSProperties has no index signature to take it on its own.
  const panelStyle: CSSProperties & { "--picker-column": string } = {
    ...(coords ?? { position: "fixed", visibility: "hidden" }),
    "--picker-column": `${COLUMN_WIDTH}px`,
    // `coords` carries the max-* that caps this to the room the chosen side
    // actually has.
    width: `min(${PANEL_WIDTH}px, calc(100vw - 1.5rem))`,
    height: `min(${PANEL_HEIGHT}px, calc(100dvh - 1.5rem))`,
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Select a folder on ${host?.name ?? "host"}`}
      style={panelStyle}
      className={cn(
        // pointer-events-auto: opened from inside a modal Radix dialog, this
        // portal would otherwise inherit the `pointer-events: none` that
        // dialog puts on the body.
        "pointer-events-auto z-[100] flex flex-col overflow-hidden rounded-xl",
        "border border-popover-border bg-popover text-popover-foreground",
        "shadow-2xl shadow-black/50 animate-in fade-in-0 zoom-in-95 duration-100",
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {/* One row, two layers: the trail with its options menu, and the
            filter field growing leftward out of the button that opens it. The
            field is always mounted at the row's right edge so the toggle never
            moves — collapsed it is exactly the button, expanded it covers the
            trail. */}
        <div className="relative flex h-9 shrink-0 items-center gap-2">
          {/* Only for a picker reached through a cascade or a host dialog: it
              steps back to that, not up the folder trail, which is what the
              crumbs and the leftmost column are already for. */}
          {onBack && (
            <div
              aria-hidden={searchOpen}
              className={cn(
                "flex h-9 shrink-0 items-center rounded-md border border-border bg-card/35 px-1",
                "transition-opacity duration-150 ease-swift",
                searchOpen && "opacity-0",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                tabIndex={searchOpen ? -1 : 0}
                aria-label="Back"
                onClick={onBack}
              >
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
            </div>
          )}
          <div
            aria-hidden={searchOpen}
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center rounded-md border border-border bg-card/35 pr-1",
              // Room for the collapsed field, plus the gap between them.
              "mr-11 transition-opacity duration-150 ease-swift",
              searchOpen && "opacity-0",
            )}
          >
            <nav
              aria-label="Folder breadcrumbs"
              className="flex h-9 min-w-0 flex-1 items-center overflow-x-auto px-1"
            >
              {breadcrumbs.map((item, index) => (
                <span key={item.path} className="inline-flex shrink-0 items-center">
                  <button
                    type="button"
                    tabIndex={searchOpen ? -1 : 0}
                    onClick={() => navigate(item.path)}
                    className="inline-flex h-8 max-w-40 items-center gap-1 truncate rounded px-2 text-xs hover:bg-accent"
                  >
                    {index === 0 && <Home className="size-3" aria-hidden />}
                    {item.label}
                  </button>
                  <CrumbDrillMenu
                    hostId={host?.id ?? null}
                    client={state === "ready" ? client : null}
                    dirPath={item.path}
                    activeChild={breadcrumbs[index + 1]?.path ?? null}
                    showHidden={showHidden}
                    onNavigate={navigate}
                  />
                </span>
              ))}
            </nav>
            <DropdownMenu
              className="shrink-0"
              renderTrigger={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="ghost"
                  size="icon"
                  tabIndex={searchOpen ? -1 : 0}
                  className="size-7"
                  aria-label="Folder list options"
                >
                  <Ellipsis className="size-4" aria-hidden />
                </Button>
              )}
            >
              <DropdownMenuItem checked={showHidden} onSelect={toggleHidden}>
                Show hidden folders
              </DropdownMenuItem>
            </DropdownMenu>
          </div>

          <div
            className={cn(
              "absolute inset-y-0 right-0 flex items-center justify-end overflow-hidden",
              "rounded-md border border-border bg-card/35 transition-[width] duration-200 ease-swift",
              searchOpen ? "w-full" : "w-9",
            )}
          >
            {searchOpen && (
              <>
                <Search
                  className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
                  aria-hidden
                />
                <input
                  ref={searchRef}
                  type="text"
                  aria-label="Filter folders"
                  placeholder={`Filter folders in ${breadcrumbs.at(-1)?.label ?? "this folder"}`}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  className="h-8 min-w-0 flex-1 bg-transparent pl-8 text-sm outline-none placeholder:text-muted-foreground"
                />
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mr-1 size-7 shrink-0"
              aria-label={searchOpen ? "Close filter" : "Filter folders"}
              aria-expanded={searchOpen}
              onClick={() => {
                // Folding it away clears it too: a filter still narrowing the
                // list from behind a collapsed button is a list that lies.
                setSearchOpen((value) => !value);
                setFilter("");
              }}
            >
              {searchOpen ? (
                <X className="size-4" aria-hidden />
              ) : (
                <Search className="size-4" aria-hidden />
              )}
            </Button>
          </div>
        </div>

        {connecting && (
          <div
            className="flex shrink-0 items-center gap-2 px-1 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            <span>Connecting to {host?.name ?? "host"}…</span>
          </div>
        )}

        <div
          ref={stripRef}
          className="flex min-h-0 flex-1 overflow-x-auto rounded-lg border border-border bg-card/35"
        >
          {pickerUnavailable ? (
            <div
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
              role="alert"
            >
              <span className="flex size-9 items-center justify-center rounded-full bg-destructive-soft text-destructive">
                <WifiOff className="size-4" aria-hidden />
              </span>
              <div className="space-y-1">
                <p className="text-sm font-medium">Couldn’t connect to {host?.name ?? "host"}</p>
                <p className="max-w-72 text-xs leading-relaxed text-muted-foreground">
                  {failureDetail}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={retryPicker}>
                Retry
              </Button>
            </div>
          ) : (
            columns.map((column, index) => {
              const query = columnQueries[index];
              const entries = columnEntries[index] ?? [];
              const all = query?.data?.entries ?? [];
              const hiddenCount = showHidden
                ? 0
                : all.filter((entry) => entry.is_dir && entry.name.startsWith(".")).length;
              return (
                <FolderColumn
                  key={column.path}
                  first={index === 0}
                  tabIndex={index === leafIndex ? 0 : -1}
                  folderPath={column.path}
                  entries={entries}
                  selectedPath={column.selectedChild}
                  selectedRef={index === trailIndex ? selectedRef : undefined}
                  columnRef={index === leafIndex ? leafColumnRef : undefined}
                  pending={chrome || (query?.isPending ?? true)}
                  errorMessage={query?.isError ? listErrorMessage(query.error) : null}
                  empty={emptyState(index, hiddenCount)}
                  truncated={query?.data?.truncated ?? false}
                  onSelect={navigate}
                  onKeyDown={onColumnKeyDown}
                />
              );
            })
          )}
        </div>

        {creatingFolder && (
          <form
            className="flex shrink-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitFolder();
            }}
          >
            <Input
              autoFocus
              aria-label="New folder name"
              placeholder="New folder name"
              value={folderName}
              disabled={mkdirM.isPending}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setCreatingFolder(false);
              }}
            />
            <Button
              type="submit"
              disabled={
                !isValidPathLeafName(
                  pathFlavor === "windows" ? folderName : folderName.trim(),
                  pathFlavor,
                ) || mkdirM.isPending
              }
            >
              Create
            </Button>
          </form>
        )}
        {mkdirM.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mkdirM.error instanceof Error ? mkdirM.error.message : "Could not create the folder."}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-popover-border p-3">
        <Button
          type="button"
          variant="ghost"
          className="mr-auto"
          disabled={!client || state !== "ready"}
          onClick={() => setCreatingFolder((value) => !value)}
        >
          <FolderPlus className="size-4" aria-hidden />
          New folder
        </Button>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" disabled={!selectable} onClick={commit}>
          Select this folder
        </Button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Host filesystem errors, said the way someone picking a folder would hear
 * them. The raw codes leak the daemon's jail vocabulary ("outside the home
 * root") into a dialog whose user never asked about roots.
 */
function listErrorMessage(error: unknown): string {
  if (error instanceof HostControlError) {
    switch (error.code) {
      case "outside_root":
      case "traversal_rejected":
        return "That folder sits above your home folder, which is as far up as SPAWN D can browse.";
      case "permission_denied":
        return "You do not have permission to open this folder.";
      case "not_found":
        return "This folder no longer exists.";
      case "not_directory":
        return "That is a file, not a folder.";
      case "symlink_rejected":
        return "This is a symbolic link, which SPAWN D does not follow.";
    }
  }
  return error instanceof Error ? error.message : "Could not list this folder.";
}
