# P2-07 — Files: explorer, preview, uploads and downloads

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§3 D4, §5, §8), then `research/11-files-and-preview.md` **in
full**. It documents two *different* transfer protocols that must not be merged.

## 1. Objective

The Files tab root and the host file browser, over the `spawn.host.ctl` DataChannel.

## 2. Files you own

```
src/app/(tabs)/files/**
src/app/host/[id]/files.tsx
src/components/files/**
src/data/queries/files.ts
```

## 3. Specification

### 3.1 Transport

**There is no server file-content endpoint** (`research/11 §1.1`). Listings, reads, writes,
previews and detailed errors all travel over the host-scoped `spawn.host.ctl` WebRTC DataChannel.
Use `P1-09`'s `HostTransport`; do not attempt HTTP.

### 3.2 Listing

`research/11 §TL;DR 2`: `fs.list` returns **unsorted** pages of at most **96 entries**, scans at
most **1,024**, exposes dotfiles, **rejects all symlink traversal**, and is rooted at the daemon
user's canonical home directory.

- Preserve daemon order and require an explicit **"Load more"**, matching the web explorer
  (`research/11 §TL;DR 3`). Do not silently auto-paginate the explorer.
- Breadcrumbs, dotfile toggle, and the real error cases (no access, too large, symlink rejected).
- `FlashList`; rows show name, kind icon, size, mtime as the web does.

### 3.3 Preview

`research/11 §TL;DR 8-9` gives the complete classification table and the exact size thresholds:
text decodes at most **1 MiB / 5,000 lines**, unsolicited previews stop at **4 MiB**, inline
previews at **24 MiB**, PDF at **128 MiB**, media at **512 MiB**. Enforce all of them.

- The syntax highlighter is a **deliberately bounded hand-written scanner**, not Shiki/Prism —
  port it as-is with its tests. Do not substitute a highlighting library.
- Markdown is GFM **without raw HTML**, blocking unsafe URLs and suppressing remote images. Match
  that security posture exactly in whatever RN markdown renderer you use from the installed set.
- Images via `expo-image`. PDF inline rendering is flagged as needing a device spike
  (`research/11 §TL;DR 10`) — implement the straightforward path and record the risk.

### 3.4 Transfers

**Two protocols. Do not unify them** (`research/11 §Scope`):

- **Host files** (`spawn.host.ctl`): 8 KiB verified chunks, SHA-256, bounded backpressure, 60s
  stream timeout, cancellation, atomic writes, **512 MiB** ceiling.
- **Session uploads** (`spawn.ctl`): 20 MiB, 48 KiB chunks — that is `P1-09`'s and `P2-05`'s
  surface, not yours. Do not implement it here.

Downloads land via `expo-file-system` with a share-sheet/"Save to Files" hand-off; uploads source
from `expo-document-picker` / `expo-image-picker` if installed. Progress, cancel and failure states
throughout.

## 4. Rules
- Never merge the two transfer protocols behind one retry policy.
- Enforce every size threshold before fetching, not after.
- Fail closed on symlinks and permission errors, with accurate copy.

## 5. Tests
- File-kind classification: the full table from `research/11 §TL;DR 8`, one case per kind.
- Threshold enforcement at each boundary (1 MiB, 4 MiB, 24 MiB, 128 MiB, 512 MiB).
- The ported highlighter's tests.
- Pagination: 96-entry pages, explicit load-more, order preserved.
- Chunking at 8 KiB with SHA-256 verification; cancellation; timeout.
- Markdown renderer blocks raw HTML, unsafe URLs and remote images.

## 6. Deliverables checklist
- [ ] Explorer over `HostTransport` with correct paging and ordering
- [ ] Complete preview classification and thresholds
- [ ] Ported highlighter and hardened markdown
- [ ] Host download/upload with 8 KiB verified chunks and full progress/cancel
- [ ] Session uploads NOT implemented here
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-07.md`; report `docs/native/reports/P2-07.md`.
