# R11 — Files, transfers, and content preview

- **TL;DR 1/10 —** Host file names, paths, listings, reads, writes, previews, and detailed errors travel over the ordered, reliable `spawn.host.ctl` WebRTC DataChannel; the FastAPI server authenticates and relays signaling but never receives file content.
- **TL;DR 2/10 —** `fs.list` returns unsorted pages of at most 96 entries, scans at most 1,024 entries, exposes dotfiles, rejects all symlink traversal, and is rooted at the daemon user's canonical home directory.
- **TL;DR 3/10 —** The web explorer preserves daemon order and requires explicit “Load more”; the launch folder picker instead drains up to 12 pages, keeps directories only, hides dot-directories by default, filters the leaf column, and sorts case-insensitively.
- **TL;DR 4/10 —** The folder picker has Finder-style derived columns and crumbs but no favourites and no displayed recents; an existing authenticated HTTP API does expose the eight most recently used session directories.
- **TL;DR 5/10 —** Host downloads and explorer uploads use 8 KiB verified chunks, SHA-256, bounded backpressure, a 60-second stream timeout, cancellation, atomic writes, and a hard 512 MiB daemon limit.
- **TL;DR 6/10 —** Terminal-session uploads are a different `spawn.ctl` protocol: 20 MiB maximum, 48 KiB binary chunks, resumable stable upload UUID, four active uploads/viewer, durable pre-final reconciliation, and `outcome_unknown` after final dispatch.
- **TL;DR 7/10 —** The terminal upload bar is a size-weighted pure state machine: aggregate clamped bytes, show at least 4%, remain visible for 420 ms, paint complete when settled, then fade for 200 ms; port its tests unchanged.
- **TL;DR 8/10 —** Preview classification is name-based and complete below; text decodes at most 1 MiB/5,000 lines, unsolicited previews stop at 4 MiB, normal inline previews at 24 MiB, PDF at 128 MiB, and media at 512 MiB.
- **TL;DR 9/10 —** The syntax highlighter is a deliberately bounded hand-written scanner, not Shiki/Prism; Markdown uses GFM without raw HTML, blocks unsafe URLs, and suppresses remote images.
- **TL;DR 10/10 —** **RECOMMEND:** target Expo SDK 54 for the required physical-iPhone Expo Go pass; use Expo filesystem/pickers/media/share modules, but treat the hidden WebView WebRTC bridge and inline local-PDF rendering as mandatory physical-device spikes.

## Scope and terminology

This report distinguishes two file-transfer surfaces that look similar in the UI but are not wire-compatible:

1. **Host files** are the general filesystem explorer rooted at the host user's home directory. They use the host-scoped `spawn.host.ctl` DataChannel and allow files up to 512 MiB (`daemon/src/host_files.rs:29-40`).
2. **Session uploads** originate inside a live terminal. They use the session-scoped `spawn.ctl` DataChannel, target either the retained session cwd or `.spawn/attachments`, and allow files up to 20 MiB (`web/src/lib/session-ctl.ts:1-16`).

The native app must not merge these contracts behind one falsely uniform retry policy. In particular, their acknowledgement boundaries, chunk sizes, size ceilings, collision handling, and reconciliation behavior differ.

## 1. Transport and trust boundary

### 1.1 There is no server file-content endpoint

The host-control browser socket is:

```text
/ws/host?host_id=<uuid>
```

It authenticates the account, verifies host ownership, selects the bound host/daemon connection, and relays WebRTC signaling (`server/spawn_server/ws/host.py:381-444`). The browser then creates an ordered, fully reliable DataChannel named `spawn.host.ctl`; the server never receives its messages (`proto/README.md:1048-1086`).

The protocol's opening frame is concrete and versioned:

```json
{"version":1,"type":"hello","protocol":"spawn.host.ctl","capabilities":["ping","fs.home","fs.list","fs.stat","fs.read","fs.read.range","fs.write.begin","fs.mkdir","fs.rename","fs.remove","fs.preview","host.metrics","desktop.reveal","desktop.open"],"limits":{"frame_bytes":16384,"chunk_bytes":8192,"file_bytes":536870912,"directory_entries":1024,"range_bytes":16777216,"preview_bytes":2097152,"preview_pixels":[128,256,512,1024],"normal_queue":64,"fast_queue":64,"long_tasks":8,"write_reapers":1}}
```

Source: `proto/README.md:1061-1079`.

Control frames are UTF-8 JSON no larger than 16 KiB. Request IDs are no larger than 128 bytes. Binary control messages, malformed JSON, the wrong version, oversized frames, an unordered channel, or a channel configured with partial reliability close the channel (`proto/README.md:1067-1086`).

The browser request shape is:

```ts
{
  version: 1,
  type: "request",
  request_id: requestId,
  operation,
  ...(payload === undefined ? {} : { payload }),
}
```

The client permits at most 32 outstanding requests, uses a 15-second ordinary request timeout, sends a cancellation frame on abort/timeout, and rejects responses not bound to an outstanding request (`web/src/lib/hostControl.ts:7-20`, `web/src/lib/hostControl.ts:348-418`).

**RECOMMEND:** keep host file operations in a dedicated `HostControlClient` data service. Do not model them as REST queries and do not put sensitive paths into control-plane URLs, logs, or cache keys sent to the server.

### 1.2 FastAPI endpoints that are adjacent, but not file transport

The host files page obtains host metadata through normal authenticated HTTP and then opens host control only while the host is online (`web/src/app/hosts/[id]/files/page.tsx:27-72`). The only path-related HTTP endpoint found in this scope is recents:

```ts
export const RecentDirSchema = z.object({
  path: z.string(),
  last_used_at: z.string(),
});

/** Recently used session directories on this host, newest first (max 8). */
recentDirs: (id: string) =>
  api(`/api/hosts/${id}/recent-dirs`, {
    method: "GET",
    schema: RecentDirsSchema,
  });
```

Source: `web/src/lib/api.ts:223-232`, `web/src/lib/api.ts:576-581`.

That endpoint verifies ownership and returns the newest eight entries (`server/spawn_server/routes/hosts.py:523-546`). Session launch upserts the chosen cwd and deletes rows older than the eight newest for that account/host (`server/spawn_server/routes/sessions.py:94-125`). It does not list the directory or return file content.

The former REST `/dirs` and `/files/*` routes and server/daemon `host.fs.*` frames are explicitly retired (`proto/README.md:1271-1277`).

## 2. File browsing

### 2.1 Directory entry and page models

Port these wire types exactly, including optional/null metadata:

```ts
export interface HostDirEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  is_dir: boolean;
  size?: number | null;
  modified_at?: number | null;
}

export interface HostDirList {
  path: string;
  home_dir: string;
  parent?: string | null;
  entries: HostDirEntry[];
  next_cursor?: number | null;
  truncated?: boolean;
}
```

Source: `web/src/lib/hostControl.ts:79-99`.

The daemon's Rust model matches it field-for-field (`daemon/src/host_files.rs:80-98`). `modified_at` is integer Unix seconds, not milliseconds, and is absent/null if the metadata time cannot be read (`daemon/src/host_files.rs:981-989`, `daemon/src/host_files.rs:2258-2268`). A directory and symlink have no size; a regular file has `metadata.len()` (`daemon/src/host_files.rs:966-989`).

The list request is:

```json
{
  "version": 1,
  "type": "request",
  "request_id": "uuid",
  "operation": "fs.list",
  "payload": { "path": "/Users/me/project", "cursor": 0 }
}
```

`path` may be omitted; `cursor` starts at zero. The web client validates that a page contains no more than 96 entries and that any `next_cursor` is a safe integer strictly greater than the supplied cursor (`web/src/lib/hostControl.ts:429-465`).

### 2.2 Pagination and ordering

The daemon:

- returns at most 96 entries per page;
- refuses to scan beyond 1,024 directory entries;
- returns `next_cursor` when another page remains inside that scan budget;
- sets `truncated: true` when entries exist past 1,024;
- iterates the operating system's raw `readdir` order and does no sorting (`daemon/src/host_files.rs:29-36`, `daemon/src/host_files.rs:949-1000`).

The browser file explorer also does no sorting or filtering. It flattens each explicitly retained page in query/daemon order, recursively inserting expanded children after their parent (`web/src/components/files/FileExplorer.tsx:237-332`). “Load more” is explicit. The tree retains at most 32 pages and 3,072 entries and evicts child pages when a directory collapses (`web/src/components/files/fileExplorerPaging.ts:7-40`, `web/src/components/files/FileExplorer.tsx:525-560`).

The full explorer has no breadcrumb bar: location is conveyed by the rooted, indented expansion tree. Its root label is the requested root/home/cwd, while the folder picker is the surface with interactive crumbs (`web/src/components/files/FileExplorer.tsx:969-970`, `web/src/components/workspace/folder-picker.tsx:431-625`).

This means the web explorer's visible order is intentionally not alphabetical. Porting a generic native file-list component that silently sorts will break parity.

**RECOMMEND:** preserve host order in the full explorer and expose an explicit “Load more” footer. Preserve the folder picker's different alphabetical directory-only behavior, documented later, rather than forcing one global sort policy.

### 2.3 Hidden files

The daemon skips only the synthetic `.` and `..` entries; names beginning with `.` remain ordinary entries (`daemon/src/host_files.rs:961-967`). The full `FileExplorer` has no hidden-files filter or toggle, so dotfiles are visible.

The folder picker has its own rule: it filters dot-directories unless “Show hidden folders” is enabled and persists that boolean in local storage under `spawn.folderPicker.showHidden` (`web/src/components/workspace/folder-picker.tsx:36-36`, `web/src/components/workspace/folder-picker.tsx:104-115`). It never lists files at all (`web/src/components/workspace/folder-picker-helpers.ts:4-21`).

**RECOMMEND:** use device local storage for the native hidden-folder preference with the same semantic key. Do not hide dotfiles in the general explorer.

### 2.4 Root, path normalization, and containment

The daemon discovers `dirs::home_dir()`, falling back to the process cwd only if home discovery fails, canonicalizes it, and opens it once as a capability root (`daemon/src/host_files.rs:755-779`). Every later operation is relative to held directory handles rather than ambient filesystem paths (`daemon/src/host_files.rs:1-5`).

Accepted path forms are:

- empty string or `~`: the capability root;
- `~/child`: relative to the capability root;
- an absolute path whose canonical textual prefix is the opened root;
- a relative path, also interpreted under the root (`daemon/src/host_files.rs:826-853`).

Rejected path content:

- NUL: `invalid_path`;
- absolute path outside root: `outside_root`;
- `..`, a second root, or platform prefix component: `traversal_rejected`;
- any symlink component: `symlink_rejected`;
- non-directory intermediate component: `not_directory` (`daemon/src/host_files.rs:826-897`).

The client helpers are POSIX-only:

```ts
export function normalizeAbsolutePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}
```

Source: `web/src/lib/paths.ts:44-61`.

The UI root is therefore the host's reported `home_dir`, not filesystem `/`. `parent` is null at that root (`daemon/src/host_files.rs:990-999`). FileExplorer deep links only expand a path equal to or below its resolved root, and cap automatic ancestor expansion at 31 child pages (`web/src/components/files/FileExplorer.tsx:455-476`).

#### Windows

The current daemon does not ship for Windows (`web/src/app/download/page.tsx:45-50`). The implementation uses Unix metadata identity and `rustix` rename operations (`daemon/src/host_files.rs:2244-2259`, `daemon/src/host_files.rs:2050-2084`). The path helpers split `/`, not `\` (`web/src/lib/paths.ts:3-61`). Windows-looking file extensions such as `.exe`, `.dll`, `.bat`, `.cmd`, and `.lnk` are classification labels, not evidence of a Windows host implementation (`web/src/lib/preview/file-kinds.ts:335-383`).

**RECOMMEND:** preserve host paths as opaque protocol strings outside the pure POSIX presentation helpers. Do not run them through `expo-file-system`, `path.win32`, or URL normalization. A future Windows daemon requires a protocol/path-design decision, not a mobile-only guess.

### 2.5 Permissions, symlinks, and special files

The top-level I/O error map is:

| Rust error kind | protocol code |
|---|---|
| `NotFound` | `not_found` |
| `PermissionDenied` | `permission_denied` |
| `AlreadyExists` | `already_exists` |
| `InvalidInput` | `invalid_path` |
| other I/O | `io_error` |

Source: `daemon/src/host_files.rs:42-67`.

Symlinks are returned in listings as `{kind:"symlink", is_dir:false}` but cannot be traversed, read, previewed, overwritten, renamed through, or removed through the no-follow service (`daemon/src/host_files.rs:863-897`, `proto/README.md:1187-1195`). The preview classifier gives symlinks a metadata-only state. Directories and `other` entries—FIFO, device, socket, and similar—are also not preview targets (`web/src/lib/preview/file-kinds.ts:463-490`).

Read additionally requires a regular file, returning `not_file` otherwise, refuses files greater than 512 MiB with `file_too_large`, and returns `file_changed` if the file's length changes while it is hashed (`daemon/src/host_files.rs:1151-1199`).

Mutations protect the home root. Rename/remove root returns `root_protected`; recursive delete is explicitly requested for directories (`daemon/src/host_files.rs:877-884`, `web/src/components/files/FileExplorer.tsx:634-652`).

### 2.6 Full explorer interactions to preserve

The current explorer exposes:

- expand/collapse directories and explicit load-more;
- create folder;
- multi-file upload and drag/drop into a target directory;
- open preview;
- host-native reveal/open when advertised and safe;
- copy absolute or root-relative path;
- download;
- rename;
- direct cross-host send to another online host's home;
- recursive delete (`web/src/components/files/FileExplorer.tsx:501-581`, `web/src/components/files/FileExplorer.tsx:584-712`, `web/src/components/files/FileExplorer.tsx:891-960`).

Keyboard behavior is exact:

| Key | Action |
|---|---|
| Arrow Down / Up | select next/previous flat tree row; clamp at ends |
| Arrow Right | expand selected directory |
| Arrow Left | collapse selected directory, otherwise select parent row |
| Enter | toggle directory or open file viewer |
| Space | pin quick preview for file |
| Escape | cancel quick preview |
| F2 | rename |
| Delete | open delete confirmation |

Source: `web/src/components/files/FileExplorer.tsx:805-847`.

**RECOMMEND:** on phone, use one current-directory `FlatList`/FlashList rather than a deeply indented tree. Keep the same operations in a native context/action sheet, add a visible parent/back affordance and horizontal crumbs, and preserve a navigation stack so swipe-back is tactile. This changes shape for phone ergonomics without changing data semantics.

## 3. Folder picker for session launch

### 3.1 Where it appears in launch flow

From the new-session menu:

- “Tab home” and “Workspace” are immediate preset cwd choices.
- An explicit “Elsewhere…” path goes to host selection and then folder selection.
- With one eligible host, the flow can proceed directly; with multiple hosts, it first asks for a host; offline hosts are disabled (`web/src/components/workspace/new-session-menu.tsx:94-108`, `web/src/components/workspace/new-session-menu.tsx:203-235`).
- On selection, the caller receives the chosen absolute host path and continues session creation (`web/src/components/workspace/new-session-menu.tsx:300-327`).

The picker enables host control only while open and the chosen host is online (`web/src/components/workspace/folder-picker.tsx:87-93`). It resolves `~`/initial cwd after `fs.home` returns, then clamps any stale or foreign path to the current host's home (`web/src/components/workspace/folder-picker.tsx:117-140`).

### 3.2 Derived columns and crumbs

Desktop uses a Finder-style column browser. Constants are 224 px/column, two visible columns, 474 px preferred width including chrome, and 440 px preferred height (`web/src/components/workspace/folder-picker.tsx:38-51`).

The trail is not mutable navigation history. It is derived from `path` every render:

```ts
export type FolderColumn = {
  path: string;
  selectedChild: string | null;
};

export function folderColumns(path: string, homeDir: string): FolderColumn[] {
  const trail = breadcrumbParts(path, homeDir);
  return trail.map((crumb, index) => ({
    path: crumb.path,
    selectedChild: trail[index + 1]?.path ?? null,
  }));
}
```

Source: `web/src/components/workspace/folder-picker-helpers.ts:79-101`.

`breadcrumbParts` starts at a `Home` crumb (or `/` if home itself is `/`), omits ancestors above home, and builds one crumb for each slash-separated child (`web/src/components/workspace/folder-picker-helpers.ts:50-77`). Every column lists its path; the selected child is highlighted; the last column lists the current folder's children with no child selected (`web/src/components/workspace/folder-picker-column.tsx:25-143`).

Crumbs can be clicked directly. Their chevron drill menu lazily loads all directory pages for the crumb, applies the same visible-directory function, and marks the current branch (`web/src/components/workspace/folder-picker-crumbs.tsx:19-87`).

On initial open at a deep path, the strip positions the selected folder in context. Subsequent drill-in smoothly scrolls to the new trailing column (`web/src/components/workspace/folder-picker.tsx:273-303`).

### 3.3 Listing, filtering, and hidden folders

Unlike the explorer, every visible column drains pagination:

```ts
export const FOLDER_PAGE_BUDGET = 12;

export async function listAllEntries(fetchPage, budget = FOLDER_PAGE_BUDGET) {
  const entries = [];
  let cursor = 0;
  for (let page = 0; page < budget; page += 1) {
    const result = await fetchPage(cursor);
    entries.push(...result.entries);
    if (result.truncated === true) return { entries, truncated: true };
    if (typeof result.next_cursor !== "number") return { entries, truncated: false };
    cursor = result.next_cursor;
  }
  return { entries, truncated: true };
}
```

Source: `web/src/components/workspace/folder-picker-helpers.ts:104-136`.

Twelve rounds cover the daemon's 1,024-entry ceiling at 96/page. This is necessary because raw page order is arbitrary; a first-page-only directory picker could omit most directories (`web/src/components/workspace/folder-picker-helpers.ts:104-136`).

Visible entries are:

1. directories only (`is_dir`);
2. excluding leading-dot names unless show-hidden is true;
3. filtered by case-insensitive substring when the leaf filter is nonempty;
4. sorted with `localeCompare(..., {sensitivity:"base"})` (`web/src/components/workspace/folder-picker-helpers.ts:4-21`).

The filter applies only to the trailing/leaf column. Ancestor columns stay complete so the currently selected branch cannot disappear (`web/src/components/workspace/folder-picker.tsx:159-169`).

### 3.4 Selection, validation, mkdir, and dismissal

All navigation is re-normalized and clamped under home. Navigation clears the leaf filter (`web/src/components/workspace/folder-picker.tsx:171-180`).

The sticky footer selects the current folder, not a highlighted child. Committing the same normalized path supplied as `initialPath` only closes; it does not call `onSelect`, avoiding a redundant session `cd` or workspace mutation (`web/src/components/workspace/folder-picker.tsx:322-335`).

New-folder UI validation trims the name and rejects empty, `.`, `..`, and `/` (`web/src/components/workspace/folder-picker.tsx:305-320`). The daemon is authoritative and additionally rejects:

- UTF-8 byte length above 255;
- backslash;
- any control character (`daemon/src/host_files.rs:2271-2282`).

**RECOMMEND:** port the daemon-compatible validation into a shared pure `validateLeafName()` and show the precise reason before submit. Keep daemon errors authoritative; avoid the current desktop gap where `\`, controls, and overlong UTF-8 reach the wire.

Picker list errors are deliberately translated from daemon vocabulary (`web/src/components/workspace/folder-picker.tsx:680-702`):

| Error code | Exact current message |
|---|---|
| `outside_root`, `traversal_rejected` | “That folder sits above your home folder, which is as far up as Spawn can browse.” |
| `permission_denied` | “You do not have permission to open this folder.” |
| `not_found` | “This folder no longer exists.” |
| `not_directory` | “That is a file, not a folder.” |
| `symlink_rejected` | “This is a symbolic link, which Spawn does not follow.” |
| other | underlying error message, otherwise “Could not list this folder.” |

Outside click dismisses. Escape first closes and clears search; a second Escape closes the picker. Escape inside a nested menu belongs to that menu (`web/src/components/workspace/folder-picker.tsx:229-257`).

### 3.5 Keyboard behavior

The leaf list receives focus after open (`web/src/components/workspace/folder-picker.tsx:265-271`).

| Key | Exact picker behavior |
|---|---|
| Arrow Down / Up | move among current folder's sibling directories; no wrap, clamp at ends |
| Arrow Right | enter the first visible child of the current folder |
| Arrow Left | go to parent, stopping at home |
| Backspace | parent only when filter is empty |
| Enter | select current folder and close |
| Escape | close search first; close picker on next Escape |

Source: `web/src/components/workspace/folder-picker.tsx:338-350`, `web/src/components/workspace/folder-picker.tsx:406-429`.

### 3.6 Recents and favourites

There are **no favourites** in the inspected picker, helper, schema, or host file protocol. There is no favourite path model in this scope.

There are authenticated per-host **recents**, newest first and capped at eight, but the current picker does not query or render them (`web/src/lib/api.ts:223-232`, `web/src/lib/api.ts:576-581`; picker queries are `web/src/components/workspace/folder-picker.tsx:117-157`). Recents are recorded from successful session creation (`server/spawn_server/routes/sessions.py:94-125`).

**UNKNOWN:** whether “total feature parity” means reproducing the currently invisible recents API only as infrastructure, or deliberately exposing recents in the native picker. The product owner/orchestrator must decide. Showing recents is useful on phone but is a native enhancement, not present UI parity.

**RECOMMEND:** do not invent favourites in R11. If product chooses to expose recents, put a “Recent” section on the home screen of the picker, validate each tapped path by listing it, and fall back to home on `not_found`, `outside_root`, or `permission_denied`.

### 3.7 Phone-native picker proposal

**RECOMMEND:** use a swipe-dismissable full-height sheet/overlay with one folder list per route, not two squeezed desktop columns.

Proposed shape:

1. Header: Back/host label, search button, overflow menu for “Show hidden folders” and “New folder.”
2. Below header: horizontally scrolling crumbs rooted at `Home`; tapping a crumb pops to it.
3. Body: native virtualized list of sorted visible subdirectories. A row tap pushes the child route with horizontal motion and selection haptic.
4. Gesture: edge/right swipe pops one path component; downward sheet swipe cancels. Disable dismissal while a mkdir mutation is past dispatch unless the mutation state can remain globally visible.
5. Sticky footer: `Select “<basename>”`, disabled until `fs.home` and current listing/path validity are known.
6. Search: inline full-width field filtering only current folder; Escape/hardware keyboard behavior matches web. On touch, a clear button replaces the “first Escape” function.
7. Empty states: distinguish no matches, only hidden folders, no subfolders, permission error, missing folder, and truncated directory.
8. Optional product-approved recent screen only at home; never mix stale recent paths into the live directory's sorted children.

This preserves the derived trail invariant: canonical state remains one `currentPath`; navigation screens/animations derive from its breadcrumb parts. Do not maintain an independent crumb history that can drift from the path.

## 4. Host-file downloads

### 4.1 Read frame protocol

The full-file sequence is:

```json
{"version":1,"type":"request","request_id":"r","operation":"fs.read","payload":{"path":"~/a.txt"}}
{"version":1,"type":"response","request_id":"r","ok":true,"result":{"stream_id":"s","path":"/home/me/a.txt","name":"a.txt","length":2,"sha256":"...64 hex..."}}
{"version":1,"type":"stream.chunk","stream_id":"s","sequence":0,"bytes_b64":"aGk="}
{"version":1,"type":"stream.ack","stream_id":"s","sequence":1}
{"version":1,"type":"stream.end","stream_id":"s","length":2,"sha256":"...64 hex..."}
```

Source: `proto/README.md:1235-1245`.

The daemon computes the entire SHA-256 before declaring the stream, rewinds, then hashes/validates while sending. A mutation during this process produces a stream error rather than a successful end (`daemon/src/host_files.rs:1129-1200`, `proto/README.md:1247-1255`).

Flow control:

- chunk payload: 8 KiB;
- maximum unacknowledged chunks: eight = 64 KiB in flight;
- receiver sends `stream.ack` as its `ReadableStream` pulls;
- browser stream high-water mark: four chunks;
- stream inactivity timeout: 60 seconds;
- SCTP buffered-amount high-water for writes: 256 KiB (`web/src/lib/hostControl.ts:7-20`, `web/src/lib/hostControl.ts:489-554`).

Integrity validation on receipt requires:

- exact next sequence;
- nonempty decoded chunk no larger than 8 KiB;
- cumulative bytes no greater than declared length;
- `stream.end.length` equal declaration and bytes received;
- `stream.end.sha256` equal declaration;
- incremental local SHA-256 equal declaration (`web/src/lib/hostControl.ts:1269-1404`).

An invalid/replayed/unknown stream frame is protocol-fatal except for the strictly bounded already-authorized cancellation tombstone window (`web/src/lib/hostControl.ts:1436-1582`).

### 4.2 Cancellation and failure

Cancelling the consumer:

- clears the stream timer;
- records a bounded incoming tombstone;
- removes live stream state;
- sends a `stream.cancel` frame (`web/src/lib/hostControl.ts:489-554`).

The sender is allowed to have up to eight already-authorized chunks in flight; the cancelled receiver validates and drains only that bounded late window. Unknown, excessive, duplicate, or replayed frames still fail closed (`web/src/lib/hostControl.test.ts:1021-1099`).

Common definitive failures include `not_found`, `permission_denied`, `not_file`, `symlink_rejected`, `file_too_large`, `file_changed`, `cancelled`, `stream_timeout`, `hash_mismatch`, and protocol invalidation. Reads have no filesystem mutation, so acknowledgement loss does not create `outcome_unknown` (`web/src/lib/hostControl.test.ts:909-934`).

### 4.3 Browser behavior and its non-native limit

The browser uses `showSaveFilePicker()` when available and pipes the verified stream to the writable destination. Without it, it buffers into a Blob and triggers an object-URL download. That fallback is capped at 32 MiB (`web/src/lib/hostControl.ts:784-825`). The daemon ceiling remains 512 MiB.

The current explorer download UI sets `Downloading <name>...`, calls `saveFileToBrowser`, then clears the message or shows the error; it has no per-byte indicator and passes no user-facing cancellation signal (`web/src/components/files/FileExplorer.tsx:700-712`). The protocol declaration does expose exact total length, so native can report `received / length` without changing the wire.

The 32 MiB restriction is a browser memory fallback, not a wire limit and not a native-app requirement.

### 4.4 Native download pipeline

**RECOMMEND:** use `expo-file-system` `~19.0.23` under SDK 54, included in Expo Go. Its SDK-54 API supplies `File`, `Directory`, `Paths`, stream access, and `FileHandle`; official docs: <https://docs.expo.dev/versions/v54.0.0/sdk/filesystem/> (verified 2026-08-22).

Use two storage targets:

- `Paths.cache/spawn-downloads/<uuid>.partial` for transient preview/share downloads;
- `Paths.document/spawn-downloads/<sanitized-name>` only when the user explicitly asks the app to retain a local copy.

Native algorithm:

```ts
async function receiveVerifiedHostFile(read, destination, signal) {
  destination.create({ overwrite: false, intermediates: true });
  const handle = destination.open();
  const hash = new Sha256();
  let received = 0;
  try {
    for await (const chunk of hostReadable(read, signal)) {
      handle.writeBytes(chunk);
      hash.update(chunk);
      received += chunk.byteLength;
      reportProgress(received, read.length);
    }
    if (received !== read.length || hash.digestHex() !== read.sha256) {
      throw new Error("integrity failure");
    }
  } catch (error) {
    handle.close();
    destination.delete();
    throw error;
  }
  handle.close();
}
```

The actual host stream implementation must preserve the same ack/tombstone rules. Do not use `File.downloadFileAsync`: that API is HTTP-oriented, while these bytes arrive over a DataChannel.

After verification, call `Sharing.shareAsync(file.uri)` from `expo-sharing` `~14.0.8`, included in Expo Go. It opens the native share action sheet for a local file URL; official docs: <https://docs.expo.dev/versions/v54.0.0/sdk/sharing/>. On iOS the user can choose the system “Save to Files” activity. The app cannot silently choose an arbitrary iCloud Drive folder through `expo-sharing`.

**RECOMMEND:** the download CTA should mean “Download & Share…” on iOS. Show download progress first, then present the share sheet. If the user dismisses it, retain the cache file briefly for retry and clean it on a bounded cache policy.

Provide a cancel action during the receive phase. It must cancel the host `ReadableStream`, send the protocol cancellation, close the local handle, and delete `.partial`. Once verification succeeds and the share sheet opens, “cancel” is the system sheet's concern; the host read is already complete.

**UNKNOWN:** whether SDK-54 `FileHandle.writeBytes()` is performant enough when calls arrive every 8 KiB on the oldest supported iPhone. Benchmark batched 64–256 KiB writes while preserving protocol ACK backpressure; never acknowledge bytes that are neither durably queued nor bounded in memory.

## 5. Uploads

### 5.1 Host explorer upload protocol

Host uploads begin with:

```json
{
  "version": 1,
  "type": "request",
  "request_id": "uuid",
  "operation": "fs.write.begin",
  "payload": {
    "dir": "/Users/me/project",
    "name": "notes.txt",
    "length": 90000,
    "sha256": "64-lowercase-hex",
    "overwrite": false
  }
}
```

The daemon replies with a `stream_id`; the client sends base64 `stream.chunk` frames with exact ascending sequence, followed by:

```json
{"version":1,"type":"stream.end","stream_id":"uuid","length":90000,"sha256":"64-lowercase-hex"}
```

The web hashes the file first, opens a second stream, sends 8 KiB chunks with SCTP buffered-amount backpressure, checks exact sent length, then dispatches the end frame (`web/src/lib/hostControl.ts:827-957`). The browser's incremental `Sha256` and `hashStream(ReadableStream)` avoid a whole-file hash buffer (`web/src/lib/sha256.ts:1-124`).

Daemon validation/commit:

- leaf name satisfies the 255-byte/no-separator/no-control policy;
- declared length is no more than 512 MiB;
- SHA is 64 hex characters;
- destination directory is under root and contains no symlink component;
- existing symlink is always rejected;
- overwrite defaults false, returning `already_exists`;
- temp is a unique `.spawn-upload-<uuid>.tmp`, opened create-new/no-follow;
- every chunk is nonempty, no more than 8 KiB, and exactly sequenced;
- received length and incremental SHA must match declaration;
- file is flushed and fsynced;
- atomic rename/no-replace publishes it;
- parent directory is fsynced;
- dropping/cancelling a pending write unlinks its owned temp (`daemon/src/host_files.rs:1778-1925`, `daemon/src/host_files.rs:1928-2095`).

There is no current per-byte progress UI or user cancellation control for explorer upload. `FileExplorer` sends selected files sequentially, increments/decrements `uploadingCount`, and displays per-file success/error text (`web/src/components/files/FileExplorer.tsx:563-581`). Drag/drop feeds the same function (`web/src/components/files/FileExplorer.tsx:849-868`).

**RECOMMEND:** native may improve this to a visible per-file queue with cancel, but preserve sequential default to avoid multiplying expensive pre-hashes and P2P streams. This is a native usability enhancement, not a wire change.

### 5.2 Host upload acknowledgement boundary

Before `stream.end`, abort/peer loss is a definite non-publication and cleans the temp. Once end/commit has been dispatched, acknowledgement loss is `outcome_unknown`; commit may already have won. The client must not automatically retry (`web/src/lib/hostControl.ts:913-957`, `web/src/lib/hostControl.test.ts:1156-1223`).

The protocol requires reconciliation before a manual retry: list/stat the destination and, where needed, read it to compare expected length/SHA (`proto/README.md:1207-1228`).

Native transfer state should therefore be:

```ts
type HostUploadPhase =
  | "queued"
  | "hashing"
  | "declaring"
  | "streaming"
  | "finalizing"       // stream.end not yet sent
  | "outcome_unknown"  // stream.end sent, no definitive response
  | "complete"
  | "failed"
  | "cancelled";
```

Do not map `outcome_unknown` to ordinary red “failed”; it needs endpoint inspection and no retry button.

### 5.3 Cross-host transfer

The browser opens independently authorized source and destination host-control sessions, then pipes source `readFile()` directly to destination `writeStream()` without buffering the whole file. Neither server nor signaling WebSocket sees bytes, paths, or detailed errors (`web/src/lib/hostControl.ts:959-984`, `proto/README.md:1264-1277`). First failure cancels both sides and waits for cleanup (`web/src/lib/hostControl.test.ts:1260-1499`).

**RECOMMEND:** preserve streaming and bounded backpressure in native. Do not route through device disk unless needed for app suspension recovery; even then, that would become download-then-upload, not exact parity, and must retain two independent integrity validations.

### 5.4 Session/terminal upload is a separate protocol

The exact constants are:

```ts
export const SESSION_CTL_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SESSION_CTL_UPLOAD_CHUNK_BYTES = 48 * 1024;
export const SESSION_CTL_UPLOAD_BUFFER_HIGH_WATER = 256 * 1024;
export const SESSION_CTL_UPLOAD_BUFFER_LOW_WATER = 128 * 1024;

const CHUNK_HEADER_BYTES = 28;
const CHUNK_MAGIC = [0x53, 0x50, 0x43, 0x54]; // SPCT
```

Source: `web/src/lib/session-ctl.ts:1-16`.

Upload start:

```json
{"version":1,"kind":"request","request_id":"upload-uuid","operation":"upload_start","capability":"ready-capability-uuid","agent_generation":7,"name":"notes.txt","mime_type":"text/plain","destination":"cwd","total_bytes":90000,"chunks":2,"sha256":"64-lowercase-hex-digest"}
```

Ready/resume and completion:

```json
{"version":1,"kind":"event","event":"ready","upload_capability":"uuid","agent_generation":7,"upload_max_bytes":20971520,"upload_chunk_bytes":49152}
{"version":1,"kind":"response","request_id":"upload-uuid","operation":"upload_start","ok":true,"state":"ready","next_sequence":1,"received_bytes":49152}
{"version":1,"kind":"response","request_id":"upload-uuid","operation":"upload_complete","ok":true,"state":"complete","path":"/endpoint/path/notes.txt","total_bytes":90000,"sha256":"64-lowercase-hex-digest"}
```

Source: `proto/README.md:846-864`, `proto/README.md:901-910`.

Each binary upload frame is:

```text
+----------+---------+------+-------+----------------+----------+---------+
| "SPCT"   | version | kind | flags | request UUID   | sequence | payload |
| 4 bytes  | u8 (=1) | u8=2 | u16LE | 16 raw bytes   | u32LE    | bytes   |
+----------+---------+------+-------+----------------+----------+---------+
```

Flag bit 0 marks only the final chunk (`proto/README.md:885-901`). The TS encoder writes this exact 28-byte header little-endian (`web/src/lib/session-ctl.ts:430-458`).

Start validation is strict:

- capability and upload ID are valid request IDs;
- generation is a positive safe integer;
- total is `1..20 MiB`—zero-byte session upload is invalid;
- chunk count is exactly `ceil(total/48 KiB)`;
- name is 1..255 UTF-8 bytes, not `.`/`..`, has no separators and no C0/C1 controls;
- destination is exactly `attachments` or `cwd`;
- MIME is 1..128 ASCII graphic bytes, contains no semicolon;
- SHA is lowercase 64-hex (`web/src/lib/session-ctl.ts:368-407`).

`attachments` accepts only image MIME types or `application/json`; cwd is the general session file destination (`daemon/src/upload.rs:78-128`). Published cwd files are no-clobber. Attachment names are sanitized/uniquified in the dedicated attachments directory (`daemon/src/upload.rs:1240-1454`).

### 5.5 Session upload retry and reconciliation lifecycle

The browser reserves one of eight tab-local durable reconciliation slots **before** `upload_start`. No unresolved slot is silently evicted (`proto/README.md:912-931`).

Exact lifecycle:

1. Reserve durable record with stable upload UUID.
2. Hash the whole Blob before sending. Web's current helper buffers up to 20 MiB and uses WebCrypto SHA-256, then zeroes the buffer (`web/src/lib/session-ctl.ts:519-542`).
3. Send `upload_start`; retry only this pre-effect exchange, at most three times, using the same stable ID (`web/src/components/terminal/useSessionSocket.ts:568-658`).
4. Accept exact resume offset/sequence from an identical resident manifest.
5. Send exact 48 KiB chunks under 256/128 KiB SCTP backpressure, reporting byte progress after each chunk (`web/src/components/terminal/useSessionSocket.ts:659-733`).
6. Immediately before sending the final chunk, durably promote the record to `outcome_unknown`. A failed promotion prevents final dispatch (`proto/README.md:932-951`).
7. Never retry after final dispatch.
8. Acknowledged completion clears the record only after that clear is durably persisted.
9. Timeout, abort, generation replacement, or disconnect after final dispatch remains `outcome_unknown` even if a best-effort cancel was sent (`web/src/components/terminal/useSessionSocket.ts:734-775`, `proto/README.md:944-951`).

Daemon limits are four active uploads per viewer and 64 globally. A retry with an identical stable ID and manifest resumes or returns cached completion; a different manifest conflicts. Completed IDs are cached to avoid duplicate publication (`daemon/src/upload.rs:27-45`, `daemon/src/upload.rs:480-614`).

The retained worker cwd is an opened capability; commit writes a private mode-0600 temp and atomically no-clobber publishes it. No REST or server-WebSocket content/ack path exists (`proto/README.md:981-1006`).

**RECOMMEND:** port the durable record model to the mobile centralized data layer using an Expo-Go-compatible durable store selected by the state-layer agent. The invariant matters more than the exact storage package: no final chunk unless `outcome_unknown` is already durable, and no new upload if durable state is poisoned/full.

### 5.6 Precise upload-progress state machine

The pure aggregator is:

```ts
export type UploadTrack = { sent: number; total: number };

export function uploadRatio(tracks: readonly UploadTrack[]): number | null {
  if (tracks.length === 0) return null;
  let total = 0;
  let sent = 0;
  for (const track of tracks) {
    const size = Math.max(0, track.total);
    total += size;
    sent += Math.min(Math.max(0, track.sent), size);
  }
  if (total === 0) return 0;
  return Math.min(1, sent / total);
}
```

Source: `web/src/components/terminal/upload-progress.ts:1-23`.

Properties:

- no tracks → `null`, meaning inactive;
- totals clamp to at least zero;
- each sent count clamps to `[0, clampedTotal]`;
- concurrent files are weighted by byte size, not averaged by file count;
- all-zero total still returns active ratio `0`;
- final ratio caps at `1` (`web/src/components/terminal/upload-progress.test.ts:7-31`).

Visual state machine constants:

```ts
const MIN_VISIBLE_MS = 420;
const FADE_MS = 200;
const MIN_WIDTH = 0.04;
```

Source: `web/src/components/terminal/upload-progress-bar.tsx:6-16`.

Transitions:

| Input/event | `visible` | `fading` | painted width |
|---|---:|---:|---:|
| `ratio` becomes non-null | true | false | `max(4%, ratio)` |
| active ratio changes | true | false | 300 ms width transition |
| `ratio` becomes null before 420 ms | remains true until 420 ms elapsed | then true | immediately treated as 100% |
| fade begins | true | true | 100%, opacity → 0 over 200 ms |
| fade completes | false | true/irrelevant | unmounted |
| new upload during hold/fade | true | false | `max(4%, ratio)`, pending timers cleaned |

The bar is a 2 px absolute, pointer-events-none line at the terminal top, so it does not alter terminal geometry or consume touches (`web/src/components/terminal/upload-progress-bar.tsx:17-66`).

**RECOMMEND:** port both pure ratio tests and timing behavior. Use Reanimated/native animated width and opacity, but drive it from this state machine rather than letting animation callbacks become source-of-truth.

### 5.7 Native upload sources

**RECOMMEND:** primary “Choose files” uses `expo-document-picker` `~14.0.8`, included in Expo Go:

```ts
const result = await DocumentPicker.getDocumentAsync({
  type: "*/*",
  multiple: true,
  copyToCacheDirectory: true,
});
```

Successful assets provide `uri`, `name`, optional `size`, and optional `mimeType`. Immediate `expo-file-system` access requires `copyToCacheDirectory:true`; that copy can be expensive for large documents. Official SDK-54 docs: <https://docs.expo.dev/versions/v54.0.0/sdk/document-picker/>.

For photos/videos, `expo-image-picker` `~17.0.11` is included in Expo Go and supports both library selection and camera capture. Use original assets:

```ts
await ImagePicker.launchImageLibraryAsync({
  mediaTypes: ["images", "videos"],
  allowsMultipleSelection: true,
  allowsEditing: false,
  quality: 1,
  base64: false,
});
```

Assets include `uri`, `fileName`, `fileSize`, `mimeType`, dimensions/type, and optional duration. `base64:false` is essential. Camera capture is a native enhancement and needs explicit product placement; terminal attachment UI may sensibly offer “Photo Library” and “Take Photo.” Official SDK-54 docs: <https://docs.expo.dev/versions/v54.0.0/sdk/imagepicker/>.

Before upload:

- reject/ask before copying if declared `size` exceeds the destination limit;
- after copy, stat the actual local file and enforce 512 MiB host or 20 MiB session limit;
- normalize absent names to a safe leaf, but validate with the protocol's UTF-8-byte rule;
- derive a bounded ASCII MIME fallback such as `application/octet-stream` for cwd/host upload;
- for `attachments`, reject MIME outside image or JSON before the wire;
- stream local bytes through incremental SHA for host uploads;
- session uploads may also use incremental SHA even though web buffers, provided output is the exact same lowercase digest.

## 6. Foreground/background limits

`expo-file-system`'s native HTTP background session is not applicable: host/session transfers are WebRTC DataChannel traffic, not URLSession/HTTP downloads. Likewise Expo BackgroundTask is deferrable and scheduled by the OS, not a continuous foreground socket runner.

On iOS, when the app backgrounds, JavaScript and a hidden WKWebView/DataChannel may be suspended. A transfer cannot promise continuous progress in Expo Go.

**RECOMMEND:** treat P2P transfer as foreground-only:

1. activate `expo-keep-awake` `~15.0.8` while a transfer is actively visible;
2. observe `AppState`;
3. before final publication, cancel cleanly on inactive/background and remove local temp;
4. after final dispatch, preserve `outcome_unknown` and reconcile on foreground;
5. clean abandoned `.partial` cache files at startup;
6. tell the user “Keep spawn open until transfer finishes.”

`expo-keep-awake` is included in Expo Go and prevents screen sleep, not app suspension; official SDK-54 docs: <https://docs.expo.dev/versions/v54.0.0/sdk/keep-awake/>.

**UNKNOWN:** exact iOS suspension timing for a DataChannel owned by an offscreen `react-native-webview`. Resolve with a physical-iPhone test: start large transfer, lock, background, receive a call, switch networks, and return before/after the 60-second protocol timeout.

## 7. Preview and viewer

### 7.1 Preview kinds and type result

The client classifies from the filename because adding MIME to every 96-entry directory page would threaten the 16 KiB frame budget. The daemon remains authoritative for actual open actions (`web/src/lib/preview/file-kinds.ts:1-15`).

```ts
export type PreviewKind =
  | "image" | "svg" | "pdf" | "video" | "audio"
  | "text" | "code" | "markdown"
  | "quicklook" | "none";

export type CodeLanguage =
  | "c-like" | "js" | "ts" | "jsx" | "python" | "shell"
  | "rust" | "go" | "css" | "json" | "yaml" | "toml"
  | "sql" | "xml" | "markdown" | "plain";

export type FileTypeInfo = {
  kind: PreviewKind;
  label: string;
  mime: string;
  icon: FileIconId;
  language?: CodeLanguage;
  autoBytes: number;
  maxBytes: number;
  executable?: boolean;
};
```

Source: `web/src/lib/preview/file-kinds.ts:18-93`.

### 7.2 Complete budgets

| Budget | Exact value | Use |
|---|---:|---|
| `hoverText` | 96 KiB | head slice for hover text/code |
| `hoverImage` | 4 MiB | largest unsolicited image hover |
| `autoFetch` | 4 MiB | confirm-before-fetch threshold |
| `inlineMax` | 24 MiB | ordinary inline ceiling |
| `textDecode` | 1 MiB | maximum decoded text bytes |
| thumbnail hover | 256 px | daemon QuickLook request |
| thumbnail modal | 1,024 px | daemon QuickLook request |
| PDF max | 128 MiB | registry override |
| media max | 512 MiB | audio/video registry override |
| host QuickLook input max | 128 MiB | daemon refuses larger source |
| daemon preview output limit | 2 MiB | advertised `preview_bytes` |

Sources: `web/src/lib/preview/file-kinds.ts:101-118`, `web/src/lib/preview/file-kinds.ts:120-145`, `web/src/lib/preview/file-kinds.ts:234-242`, `daemon/src/host_files.rs:29-40`, `proto/README.md:1061-1066`.

The viewer separately checks `size <= 4 MiB` before automatic full load; above it, the user must confirm (`web/src/components/files/file-viewer-dialog.tsx:311-315`, `web/src/components/files/file-viewer-dialog.tsx:350-384`). Confirmation does not override `FileTypeInfo.maxBytes`.

### 7.3 Complete whole-name mapping

All matches are case-insensitive (`web/src/lib/preview/file-kinds.ts:162-195`).

| Whole name | Kind | Language | Icon/meaning |
|---|---|---|---|
| `Dockerfile` | code | shell | terminal |
| `Containerfile` | code | shell | terminal |
| `Makefile` | code | shell | terminal |
| `Justfile` | code | shell | terminal |
| `Rakefile` | code | shell | terminal |
| `Gemfile` | code | shell | terminal |
| `Procfile` | code | shell | terminal |
| `CMakeLists.txt` | code | shell | terminal |
| `LICENSE` | text | — | License |
| `NOTICE` | text | — | Notice |
| `README` | text | — | Readme |
| `AUTHORS` | text | — | Authors |
| `.gitignore` | code | shell | config |
| `.gitattributes` | code | shell | config |
| `.dockerignore` | code | shell | config |
| `.editorconfig` | code | toml | config |
| `.npmrc` | code | toml | config |
| `.nvmrc` | code | plain | config |
| `.prettierrc` | code | json | config |
| `.babelrc` | code | json | config |
| `.bashrc` | code | shell | terminal |
| `.zshrc` | code | shell | terminal |
| `.profile` | code | shell | terminal |
| `.DS_Store` | none | — | binary |
| `.localized` | none | — | binary |

### 7.4 Complete compound-extension mapping

Checked before single extension, longest suffix first (`web/src/lib/preview/file-kinds.ts:197-206`).

| Suffix | Kind | Language/meaning |
|---|---|---|
| `.d.ts` | code | TypeScript declarations / `ts` |
| `.min.js` | code | minified JavaScript / `js` |
| `.min.css` | code | minified stylesheet / `css` |
| `.tar.gz` | none | gzipped tar archive |
| `.tar.bz2` | none | bzip2 tar archive |
| `.tar.xz` | none | XZ tar archive |
| `.tar.zst` | none | Zstd tar archive |

### 7.5 Complete extension mapping — images and vectors

Source for this and following extension tables: `web/src/lib/preview/file-kinds.ts:208-410`.

| Extensions | Kind | MIME / label behavior |
|---|---|---|
| `png` | image | `image/png` |
| `jpg`, `jpeg` | image | `image/jpeg` |
| `gif` | image | `image/gif` |
| `webp` | image | `image/webp` |
| `bmp` | image | `image/bmp` |
| `ico` | image | `image/x-icon` |
| `avif` | image | `image/avif` |
| `apng` | image | `image/apng` |
| `heic` | quicklook | HEIC image, `image/heic` |
| `heif` | quicklook | HEIF image, `image/heif` |
| `tif`, `tiff` | quicklook | TIFF image, `image/tiff` |
| `svg` | svg | `image/svg+xml`, vector icon |
| `ai`, `eps`, `sketch`, `fig`, `afdesign` | quicklook | vector artwork/document |
| `psd`, `afphoto` | quicklook | image artwork/document |
| `svgz` | none | compressed SVG, vector icon |

### 7.6 Complete extension mapping — documents

| Extensions | Kind | Icon/label |
|---|---|---|
| `pdf` | pdf | PDF; `application/pdf`; max 128 MiB |
| `doc`, `docx`, `rtf`, `odt`, `pages` | quicklook | document |
| `xls`, `xlsx`, `ods`, `numbers` | quicklook | spreadsheet |
| `ppt`, `pptx`, `odp`, `key` | quicklook | slides |
| `epub` | quicklook | EPUB/document |

### 7.7 Complete extension mapping — media

| Extension | Kind | MIME |
|---|---|---|
| `mp4`, `m4v` | video | `video/mp4` |
| `mov` | video | `video/quicktime` |
| `webm` | video | `video/webm` |
| `ogv` | video | `video/ogg` |
| `mkv` | video | `video/x-matroska` |
| `avi` | video | `video/x-msvideo` |
| `wmv` | video | `video/x-ms-wmv` |
| `flv` | video | `video/x-flv` |
| `mp3` | audio | `audio/mpeg` |
| `m4a` | audio | `audio/mp4` |
| `aac` | audio | `audio/aac` |
| `wav` | audio | `audio/wav` |
| `flac` | audio | `audio/flac` |
| `ogg`, `oga` | audio | `audio/ogg` |
| `opus` | audio | `audio/ogg` |
| `aiff`, `aif` | audio | `audio/aiff` |

All audio/video entries override inline max to 512 MiB (`web/src/lib/preview/file-kinds.ts:120-145`). Actual device codec support may be narrower than these name mappings.

### 7.8 Complete extension mapping — prose, markup, source, and config

| Extensions | Kind | Language / MIME / icon |
|---|---|---|
| `md`, `markdown` | markdown | Markdown, `text/markdown` |
| `mdx` | markdown | MDX label, rendered as Markdown |
| `txt`, `log` | text | plain text |
| `csv` | text | `text/csv`, sheet icon |
| `tsv` | text | tab-separated, sheet icon |
| `html`, `htm`, `xhtml`, `xml` | code | `xml`; HTML is source, never rendered |
| `plist` | code | `xml`, config icon |
| `js`, `mjs`, `cjs` | code | `js` |
| `jsx` | code | `jsx` |
| `ts` | code | `ts` |
| `tsx` | code | `jsx` tokenizer |
| `json`, `jsonc`, `json5` | code | `json`, config icon |
| `yaml`, `yml` | code | `yaml`, config icon |
| `toml` | code | `toml`, config icon |
| `ini`, `conf`, `cfg` | code | `toml` tokenizer, config icon |
| `env` | code | shell, config icon |
| `css`, `scss`, `sass`, `less` | code | `css` |
| `py`, `pyi` | code | `python` |
| `rb` | code | `c-like` |
| `rs` | code | `rust` |
| `go` | code | `go` |
| `c`, `h`, `cc`, `cpp`, `cxx`, `hpp` | code | `c-like` |
| `m`, `mm` | code | `c-like` (Objective-C/C++) |
| `swift`, `java`, `kt`, `scala` | code | `c-like` |
| `php`, `pl`, `lua`, `r`, `dart` | code | `c-like` |
| `ex`, `exs`, `erl`, `hs`, `zig` | code | `c-like` |
| `sql` | code | `sql`, database icon |
| `graphql`, `gql`, `proto` | code | `c-like` |
| `diff`, `patch` | code | `plain` |

### 7.9 Complete extension mapping — scripts, archives, binaries, shortcuts

| Extensions | Kind | Flags/meaning |
|---|---|---|
| `sh`, `bash`, `zsh`, `fish` | code/shell | terminal icon, `executable:true` |
| `ps1`, `bat`, `cmd` | code/shell | terminal icon, `executable:true` |
| `zip`, `tar`, `gz`, `bz2`, `xz`, `zst`, `7z`, `rar` | none | archive |
| `dmg` | quicklook | disk-image/archive |
| `iso` | none | disk-image/archive |
| `pkg` | none | installer/archive, executable |
| `deb`, `rpm` | none | package/archive |
| `exe`, `dll`, `so`, `dylib` | none | binary, executable |
| `o`, `a`, `wasm`, `class`, `pyc` | none | binary |
| `jar` | none | archive, executable |
| `app` | none | application bundle, executable |
| `command` | none | terminal command, executable |
| `workflow`, `scpt` | none | binary, executable |
| `webloc`, `inetloc`, `fileloc`, `url`, `lnk` | none | config/indirection, executable |

“Executable” is a UI safety signal from the name. The daemon independently sniffs and refuses unsafe desktop-open targets (`web/src/lib/preview/file-kinds.ts:73-90`, `proto/README.md:1159-1185`).

### 7.10 Complete extension mapping — keys, fonts, data

| Extensions | Kind | Language/MIME/icon |
|---|---|---|
| `pem` | code | plain, key icon |
| `crt`, `cer` | none | certificate/key icon |
| `pub` | code | plain, key icon |
| `keychain` | none | key icon |
| `ttf` | quicklook | `font/ttf`, font icon |
| `otf` | quicklook | `font/otf`, font icon |
| `woff` | quicklook | `font/woff`, font icon |
| `woff2` | quicklook | `font/woff2`, font icon |
| `db`, `sqlite`, `sqlite3` | none | database icon |

### 7.11 Fallback and resolution order

Resolution is:

1. symlink/directory/other special handling;
2. case-insensitive exact whole name;
3. longest compound suffix;
4. final extension;
5. unknown extension → `quicklook`, generic file;
6. no extension → text, with documentation prefix label (`web/src/lib/preview/file-kinds.ts:412-526`).

A leading dot alone is part of a name, not an extension. A trailing dot yields no extension (`web/src/lib/preview/file-kinds.ts:412-420`).

Documentation prefixes are `readme`, `license`, `licence`, `copying`, `notice`, `authors`, `contributors`, `contributing`, `changelog`, `changes`, `codeowners`, `security`, `todo`, and `version`. They are prefix matches, so `LICENSE-MIT` and `CHANGELOG-2024` receive a useful text label (`web/src/lib/preview/file-kinds.ts:442-476`).

### 7.12 Text loading and binary detection

For text/code/Markdown:

- full viewer limit: 1 MiB and 5,000 lines;
- quick/hover limit: 96 KiB and 200 lines;
- if known full size exceeds the classification `maxBytes`, refuse full display;
- `readHead` reads a small file whole but uses `fs.read.range` for large files;
- if the host lacks ranged-read capability, it declines rather than starting/cancelling a huge whole read;
- a NUL among the first 4,096 bytes means binary (`web/src/lib/preview/preview-loaders.ts:116-151`, `web/src/lib/preview/text-decode.ts:14-35`).

`decodeText`:

- applies byte cap;
- removes a trailing incomplete UTF-8 code point for partial reads;
- strips UTF-8 BOM;
- decodes UTF-8;
- normalizes CRLF to LF;
- caps lines and returns `{text,truncated,lineCount}` (`web/src/lib/preview/text-decode.ts:37-124`).

**RECOMMEND:** port `looksBinary`, `partialTailLength`, and `decodeText` 1:1. React Native/Hermes has `TextDecoder` in the target runtime only if confirmed by the app foundation; otherwise add a small pure-JS UTF-8 decoder behind the same tests, not a different behavior.

### 7.13 Syntax highlighting

The highlighter is explicitly hand-written and forward-only:

> “The scanner is deliberately small and forward-only. No regex is ever run against an unbounded suffix…”

It recognizes comments, strings, numbers, keywords, punctuation, and markup tokens, not a complete grammar (`web/src/lib/preview/code-tokenize.ts:1-13`). It caps input before scanning to 5,000 lines and 2,000 characters per line by default (`web/src/lib/preview/code-tokenize.ts:17-52`, `web/src/lib/preview/code-tokenize.ts:274-292`).

Language configurations:

| Config | Special behavior |
|---|---|
| `c-like` | C-style line/block comments, common keywords |
| `js`, `ts`, `jsx` | JS keywords, backtick multiline strings |
| `python` | `#`, single/double and triple-quoted strings |
| `shell` | `#`, shell keyword set |
| `rust` | Rust keywords, C-style comments |
| `go` | Go keywords, backtick multiline strings |
| `css` | CSS comments/keywords-ish tokens |
| `json` | strings/numbers/punctuation |
| `yaml` | `#`, YAML keyword set |
| `toml` | `#`, triple quotes |
| `sql` | `--` and block comments; keywords case-insensitive |
| `xml` | dedicated bounded markup scanner for tags/attributes/comments |
| `markdown`, `plain` | minimal/plain behavior |

Source: `web/src/lib/preview/code-tokenize.ts:75-272`, `web/src/lib/preview/code-tokenize.ts:294-527`.

Tokens use only the app's small semantic color set: keyword, string, comment, number, punctuation, tag, attribute, and plain (`web/src/components/files/preview-renderers.tsx:19-85`).

**RECOMMEND:** port `code-tokenize.ts` and its tests unchanged instead of introducing Prism, Highlight.js, Shiki, or a WebView. It is bounded, dependency-free, themeable with the same tokens, and designed for hostile/pathological files.

### 7.14 Markdown

Web declares `react-markdown ^9.1.0` and `remark-gfm ^4.0.1`; the lockfile resolves 9.1.0 and 4.0.1 respectively (`web/package.json:38-39`, `web/bun.lock:486-494`). Rendering policy is more important than the DOM component:

- GFM tables/task lists/strikethrough via `remark-gfm`;
- raw HTML is not enabled;
- only `http:`, `https:`, and `mailto:` links survive URL transform;
- links open externally in a new context;
- Markdown images are replaced by a text label instead of fetching a remote resource;
- parser import failure falls back to code/source view (`web/src/components/files/preview-renderers.tsx:261-338`).

**RECOMMEND:** use pure-JS `unified` 11.0.5 + `remark-parse` 11.0.0 + `remark-gfm` 4.0.1 and a small MDAST-to-React-Native renderer. These registry versions were verified 2026-08-22. This preserves the same GFM parser and makes the link/image policy explicit. They add no native module and are therefore eligible for Expo Go.

`react-native-markdown-display` 7.0.2 is current on npm but uses a different parsing/render stack and would make exact GFM/security parity harder. `react-native-enriched-markdown` depends on custom native code and is not an Expo Go choice.

**UNKNOWN:** ESM bundling of the selected unified/remark versions under Expo SDK 54 Metro + Hermes must be spiked. If it fails, bundle the parser code into the app build or use a locked JS-only compatible version; do not fall back to enabling raw HTML in a WebView.

### 7.15 Preview loader, progress, and cache

Loader branches:

| Classification | Operation | Result |
|---|---|---|
| text/code/Markdown | `readHead`/range | decoded string |
| image/SVG/PDF/audio/video | whole `fs.read` | local object URL on web |
| quicklook | `fs.preview` | host-rendered PNG |
| none | no read | metadata/error state |

Source: `web/src/lib/preview/preview-loaders.ts:85-195`.

Whole native previews buffer only after size checks. Progress is announced every 64 KiB while draining (`web/src/lib/preview/preview-loaders.ts:28-65`). QuickLook requests exactly 256 px for hover or 1,024 px for full modal (`web/src/lib/preview/preview-loaders.ts:177-195`).

`fs.preview` accepts only 128/256/512/1024 pixels, has a 35-second request timeout, streams PNG, and can return `preview_unsupported`, `preview_unavailable`, `preview_timeout`, `preview_too_large`, `preview_session_unavailable`, or `version_changed` (`web/src/lib/hostControl.ts:634-675`, `proto/README.md:1134-1147`). The daemon refuses source inputs above 128 MiB (`daemon/src/host_files.rs:1502-1559`).

Preview cache behavior:

- key includes host, path, modified time, size, and variant;
- 64 MiB and 32-entry global budgets;
- request de-duplication by key;
- reference-counted entries cannot be evicted;
- LRU eviction of unheld ready entries;
- at most one preview load per host;
- modal request preempts hover; hover never preempts modal;
- a newer hover supersedes queued old hover;
- disconnect/unmount clears host entries and revokes object URLs (`web/src/lib/preview/preview-cache.ts:18-50`, `web/src/lib/preview/preview-cache.ts:105-182`, `web/src/lib/preview/preview-cache.ts:219-335`, `web/src/components/files/FileExplorer.tsx:440-453`).

**RECOMMEND:** keep classification/text/tokenization cache metadata centralized, but cache native previews as local `file://` cache URIs rather than whole byte arrays. Delete evicted files and use the same 64 MiB/32-entry/refcount/priority semantics.

### 7.16 Viewer interactions and error states

The file viewer is a modal with filename/type/size/path metadata, previous/next file navigation, fit/actual-size image toggle, download, reveal/open where supported, close, and a footer indicating truncation/progress (`web/src/components/files/file-viewer-dialog.tsx:45-305`). Previous/next traverses only visible file rows, skipping directories (`web/src/components/files/FileExplorer.tsx:331-337`).

Body states are:

1. no preview target / metadata;
2. above 4 MiB auto threshold → explicit load confirmation;
3. queued/loading with cancel;
4. classified error with metadata/action fallback;
5. ready Markdown;
6. ready code/text;
7. ready PDF;
8. ready audio/video;
9. ready image/SVG/QuickLook PNG;
10. renderer failure fallback (`web/src/components/files/file-viewer-dialog.tsx:350-457`).

The web PDF renderer is `<embed type="application/pdf">`; image uses `<img>`; media uses `<audio>`/`<video controls>` (`web/src/components/files/preview-renderers.tsx:184-258`).

## 8. Native renderer equivalents

### 8.1 Images and QuickLook PNG

**RECOMMEND:** `expo-image` `~3.0.11`, included in SDK-54 Expo Go, rendering a verified cache-file URI with contain/cover fit. It provides native caching and animated-format support. Official docs: <https://docs.expo.dev/versions/v54.0.0/sdk/image/>.

QuickLook remains a host operation; native only displays the returned PNG. A Linux/old daemon without `fs.preview` shows metadata and download/share, exactly as capability derivation requires (`web/src/lib/preview/capabilities.ts:17-67`).

### 8.2 SVG

`react-native-svg` 15.12.1 is bundled in SDK-54 Expo Go; official docs: <https://docs.expo.dev/versions/v54.0.0/sdk/svg/>. `expo-image` may also decode a local SVG URI.

**RECOMMEND:** first try `expo-image` against the verified local SVG file so untrusted XML is not converted into React elements. If platform parity is insufficient, sanitize external references/scripts and render with `react-native-svg`; never execute SVG as WebView HTML.

**UNKNOWN:** verify animated SVG, linked resource, huge path-count, and malformed SVG behavior on physical iPhone. Preserve the same 24 MiB wire threshold, but add a render-complexity failure fallback because byte size alone does not bound SVG drawing cost.

### 8.3 Audio and video

**RECOMMEND:** `expo-video` `~3.0.16` and `expo-audio` `~1.1.1`, both included in SDK-54 Expo Go, using verified local cache URIs. Official docs: <https://docs.expo.dev/versions/v54.0.0/sdk/video/> and <https://docs.expo.dev/versions/v54.0.0/sdk/audio/>.

Do not assume filename-registry MIME means iOS can decode the codec. Treat player load error as renderer failure and retain Share/Open-on-host actions. The 512 MiB protocol classification ceiling is too large to buffer in JS; stream to disk first.

### 8.4 PDF

`react-native-pdf` requires custom native code and is not available in stock Expo Go. `expo-file-system` can produce the local verified file and `react-native-webview` 13.15.0 is bundled, but WKWebView local-file PDF behavior is not guaranteed by the Expo API.

**RECOMMEND:** spike local `file://` PDF display in bundled `react-native-webview` 13.15.0 on the physical target iPhone. If it passes, constrain file access to the single cache directory and block navigation. If it fails, use host `fs.preview` for a first-page PNG where available and present “Share / Save to Files” for full PDF.

**UNKNOWN:** true multipage inline PDF parity inside Expo Go. This is an orchestrator acceptance decision. A custom EAS dev/production build can use a native PDF library, but that does not satisfy the hard Expo Go endpoint.

### 8.5 Text, code, and Markdown

Use native `Text`/virtualized line rows with the ported decoder/tokenizer. Preserve monospace font, horizontal scroll, selection where feasible, line numbers, truncation note, and theme semantic token colors. Avoid nesting thousands of unvirtualized `Text` spans; tokenize once, flatten line runs, and render visible lines.

Markdown uses the pure-JS pipeline above and native components for paragraph, headings, list, task item, code, block quote, table, and link. External link presses must validate scheme again before `Linking.openURL`; images remain labels.

### 8.6 Metadata-only and binary files

For `none`, symlink, special file, binary, executable, archive, database, or unsupported quicklook:

- show icon, label, exact path, size/mtime if known;
- explain why inline content is unavailable;
- allow verified download/share for regular files within 512 MiB;
- allow reveal/open-on-host only when daemon capability and `open_allowed`/executable policy permit;
- never attempt to read a symlink/special file.

## 9. Expo Go package/version matrix

Version check date: 2026-08-22. “Registry latest” is informational; “SDK-54 pin” is the implementation recommendation because official Expo guidance during the SDK-57 transition says physical-device Expo Go projects should use SDK 54: <https://docs.expo.dev/get-started/create-a-project/>.

| Package | Registry latest | SDK-54 compatible recommendation | Expo Go | Role |
|---|---:|---:|---|---|
| `expo` | 57.0.15 | 54.0.37 | yes | required physical-iPhone Expo Go runtime |
| `expo-file-system` | 57.0.5 | `~19.0.23` | yes | cache/document files, file handles, streaming |
| `expo-document-picker` | 57.0.1 | `~14.0.8` | yes | arbitrary document source |
| `expo-image-picker` | 57.0.12 | `~17.0.11` | yes | photos/videos/camera source |
| `expo-sharing` | 57.0.14 | `~14.0.8` | yes | iOS share sheet / Save to Files |
| `expo-image` | 57.0.3 | `~3.0.11` | yes | images and returned PNG previews |
| `expo-video` | 57.0.2 | `~3.0.16` | yes | local video playback |
| `expo-audio` | 57.0.4 | `~1.1.1` | yes | local audio playback |
| `expo-keep-awake` | 57.0.1 | `~15.0.8` | yes | prevent sleep during foreground transfer |
| `react-native-webview` | 14.0.1 | `13.15.0` | yes | WebRTC transport bridge; PDF spike |
| `react-native-svg` | 15.15.5 | `15.12.1` | yes | sanitized SVG fallback |
| `unified` | 11.0.5 | 11.0.5 | JS-only; verify Hermes | Markdown AST pipeline |
| `remark-parse` | 11.0.0 | 11.0.0 | JS-only; verify Hermes | CommonMark parsing |
| `remark-gfm` | 4.0.1 | 4.0.1 | JS-only; verify Hermes | GFM parity |

Expo SDK archive versions and bundled status are from the official SDK-54 pages linked in the corresponding sections. Registry latest versions were read from npm package metadata on 2026-08-22. Use `npx expo install`, not an unconstrained npm latest, when implementation begins.

## 10. Critical Expo Go transport conflict

`react-native-webrtc` contains custom native code. Its official project states that it is not available in Expo Go and requires `expo-dev-client` plus a config plugin: <https://github.com/react-native-webrtc/react-native-webrtc>.

That conflicts directly with the hard requirement that the final app run in stock Expo Go on a physical iPhone.

**RECOMMEND:** for the Expo Go milestone, use bundled `react-native-webview` 13.15.0 as a **transport bridge only**:

- a locked, offscreen/zero-chrome WKWebView owns browser `RTCPeerConnection` and DataChannels;
- the React Native UI remains fully native;
- RN sends typed control commands to the bridge;
- bridge sends bounded typed events/byte batches back;
- bridge preserves existing JS protocol logic or a shared protocol module;
- no arbitrary navigation, remote page, DOM UI, or host content is rendered in it;
- binary crossing must use a measured encoding/batching strategy and bounded queues.

This is not a web-wrapper UI, but it is still a high-risk transport seam.

**UNKNOWN:** validate all of the following before implementation plans depend on it:

1. `RTCPeerConnection` and reliable DataChannel availability inside iOS Expo Go's WKWebView.
2. Background/offscreen throttling and screen-lock behavior.
3. 8 KiB host chunks and 48 KiB session chunks through the RN/WebView bridge without pathological base64 amplification.
4. SCTP `bufferedAmount`/low-water behavior.
5. `ArrayBuffer` ownership and message ordering.
6. reconnection after network handoff.
7. whether bridge round trips interfere with the eight-chunk ACK window.
8. memory while downloading/previewing near thresholds.
9. teardown/tombstone correctness when the React screen is swiped away.

If this spike fails, genuine native WebRTC needs a custom development/production build and therefore violates the stated Expo Go constraint. The orchestrator/product owner must then choose which hard requirement moves; there is no server-content fallback in the current architecture (`proto/README.md:1048-1086`, `proto/README.md:1271-1277`).

## 11. Recommended mobile module shape

**RECOMMEND:** keep pure parity logic separate from transport/runtime adapters:

```text
mobile/src/files/
  model/
    host-file-types.ts
    file-kinds.ts
    file-kinds.test.ts
    paths.ts
    paths.test.ts
    folder-picker.ts
    folder-picker.test.ts
    upload-progress.ts
    upload-progress.test.ts
  protocol/
    host-control-types.ts
    host-control-client.ts
    host-stream-reader.ts
    host-stream-writer.ts
    session-upload-codec.ts
    session-upload-ledger.ts
  transfer/
    sha256.ts
    local-file-source.ts
    host-download.ts
    host-upload.ts
    cross-host-transfer.ts
    session-upload.ts
    transfer-store.ts
  preview/
    text-decode.ts
    code-tokenize.ts
    preview-loader.ts
    preview-cache.ts
    markdown-renderer.tsx
    native-renderers.tsx
  components/
    FileBrowserScreen.tsx
    FolderPickerSheet.tsx
    FileViewerOverlay.tsx
    TransferProgress.tsx
    FileActionSheet.tsx
```

Central store-derived values should include:

- `directoryByHostPath` keyed locally by host ID + opaque path;
- explicitly loaded pages and next cursor;
- current picker path, derived crumbs/columns, filter, hidden preference;
- transfer phase, bytes sent/received, publication boundary, error/reconciliation;
- aggregate `uploadRatio` derived from active tracks;
- preview key/status/refcount/priority/local URI;
- host capability set, never inferred from OS.

Do not persist sensitive directory listings or paths to cloud/server storage. Recents are the only currently designed server-held path data in scope.

## 12. Pure functions to port 1:1 and parity tests

### Highest priority exact ports

1. `extensionOf`, `classifyFile`, `isNativeKind`, `isTextKind`, all registry data, and budgets from `web/src/lib/preview/file-kinds.ts:412-526`.
2. `looksBinary`, `partialTailLength`, `decodeText` from `web/src/lib/preview/text-decode.ts:14-124`.
3. `tokenizeCode` and language configs from `web/src/lib/preview/code-tokenize.ts:17-527`.
4. `joinDirectory`, `visibleDirectories`, `homeRoot`, `isWithinHome`, `parentWithinHome`, `breadcrumbParts`, `folderColumns`, `listAllEntries` from `web/src/components/workspace/folder-picker-helpers.ts:4-136`.
5. `normalizeCwdForHost`, `trimTrailingSlash`, `parentDir`, `basename`, `normalizeAbsolutePath` from `web/src/lib/paths.ts:3-61`.
6. `uploadRatio` from `web/src/components/terminal/upload-progress.ts:1-23`.
7. incremental `Sha256`/`hashStream` from `web/src/lib/sha256.ts:1-124`.
8. session upload start/cancel/chunk encoders and response parser from `web/src/lib/session-ctl.ts:368-516`.

### Existing tests to copy/adapt as acceptance tests

| Test source | Parity guaranteed |
|---|---|
| `web/src/lib/preview/file-kinds.test.ts:8-199` | extension edges, resolution order, kinds, executables, all budgets |
| `web/src/lib/preview/text-decode.test.ts:6-115` | NUL sniff, UTF-8 partial tail, BOM, CRLF, byte/line caps |
| `web/src/lib/preview/code-tokenize.test.ts:19-178` | lossless round trip, comments, strings, numbers, markup, hard limits |
| `web/src/lib/preview/preview-cache.test.ts:60-286` | key identity, dedupe, priority, cancellation, LRU/refcounts/subscriptions |
| `web/src/components/files/fileExplorerPaging.test.ts:20-40` | explicit pages, retained cap, scan ceiling |
| `web/src/components/terminal/upload-progress.test.ts:7-31` | inactive, single, weighted concurrency, zero, clamping |
| `web/src/lib/sha256.test.ts:5-18` | standard vectors, chunk boundaries, bounded stream |
| `web/src/lib/hostControl.test.ts:454-502` | list paging/validation |
| `web/src/lib/hostControl.test.ts:971-1223` | verified read, cancellation tombstones, verified write/outcome boundary |
| `web/src/lib/hostControl.test.ts:1633-1729` | ranges, QuickLook allowlist, bounded readHead behavior |

### Additional native tests required

- filesystem sink deletes partial output on cancel, length mismatch, and hash mismatch;
- share sheet is never opened before verification;
- background before final dispatch produces definite cancellation;
- background after final dispatch persists `outcome_unknown`;
- WebView bridge preserves exact message ordering and bounded memory;
- a swiped-away viewer releases preview refs and cancels only when safe;
- large local document picker copies respect available storage and destination limit;
- native text/code list does not allocate all 5,000 richly styled lines at once;
- Markdown blocks unsafe schemes and never fetches images;
- PDF failure lands on metadata/share rather than a blank surface.

## 13. Orchestrator decisions and validation gates

1. **Expo baseline:** SDK 54 is required today for physical-iPhone Expo Go despite SDK 57 being current. Decide when/how to upgrade after App Store Expo Go moves.
2. **WebRTC bridge:** approve the hidden WebView transport spike as the Expo-Go fallback, or relax Expo Go for a custom `react-native-webrtc` build.
3. **PDF:** accept WKWebView if the device spike passes; otherwise accept first-page QuickLook + Share as the Expo-Go fallback.
4. **Recents:** decide whether to expose the existing eight-entry HTTP recents API in native. Current desktop picker does not display it.
5. **Favourites:** do not schedule without a new product/storage contract; none exists.
6. **Background transfers:** accept foreground-only P2P transfers with visible warning and durable reconciliation. Expo Go cannot promise continuous WebRTC transfer while suspended.
7. **Explorer upload progress:** decide whether native adds a richer cancellable queue. The protocol supports it, but current full explorer only reports count and per-file completion.

These gates should be resolved before downstream agents treat “Expo Go compatible” as proven rather than package-level compatible.
