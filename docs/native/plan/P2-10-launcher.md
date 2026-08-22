# P2-10 — The session launcher: folder picker, agent switcher, pending launch

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §8), then `research/07-workspace-model.md §4` (launch
lifecycle, the two-stage agent launch, pending launch, shell handoff, capacity) and
`research/11-files-and-preview.md §TL;DR 3-4` (the folder picker's real behaviour).

## 1. Objective

Everything between "user taps +" and "a terminal is running".

## 2. Files you own

```
src/components/launcher/**
src/data/queries/launcher.ts
```

You are presented by `P2-04` (and possibly `P2-03`). You own no route; you export a sheet/flow
component and a hook. Publish that API in your report.

## 3. Specification

### 3.1 The flow

1. Choose a **host** (with capacity/presence shown).
2. Choose a **directory** (§3.2).
3. Choose **what to run**: a plain login shell, or an agent.
4. Optionally name the session, choose the target tab.
5. Create, then land the user in `P2-05`'s terminal.

Capacity ceilings are **8 tabs / 16 tiles per tab** (`research/07 §TL;DR 9`); host CPU/memory
telemetry and `session_count` are **displays, not launch quotas** — do not block a launch on them.

### 3.2 The folder picker

`research/11 §TL;DR 3-4`: the launch picker behaves *differently* from the file explorer. It
**drains up to 12 pages**, keeps **directories only**, hides dot-directories by default, filters the
leaf column, and sorts **case-insensitively**. There are no favourites and no displayed recents in
the web UI — but an authenticated HTTP API **does** expose the eight most recently used session
directories. Use it: on a phone, recents are worth far more than column browsing.

The web picker is Finder-style columns with crumbs. On a phone build the **phone-shaped
equivalent**: a recents list up top, then a single-column drill-down with breadcrumbs and a
"choose this folder" action. Path typing as an escape hatch (`purpose="path"` so autocorrect is
off). Do not port columns to a 390pt screen.

### 3.3 The agent launch is two-stage

`research/07 §TL;DR 10` — this surprises people, so implement it deliberately:

1. Create a **login-shell session**.
2. Then **type the constructed command into its live terminal**.

The pending command is currently **memory-only and is lost on reload/app death**. On a phone that
is worse than on desktop — the app is killed routinely. Persist the pending launch (session id +
command) so a relaunch can complete or cleanly abandon it, and surface an honest state if it was
lost. Do not silently leave a bare shell where the user expected an agent.

Command construction (argv quoting, env prefix) comes from `research/07`'s agent sections — port
its logic and tests rather than re-deriving quoting rules.

### 3.4 Shell handoff

Port the `shell-handoff` behaviour `research/07 §4` documents.

## 4. Rules
- Do not implement the terminal or the workspace list.
- Every step must be cancellable without leaving an orphaned session; if creation succeeded and a
  later step failed, say so and offer to keep or kill it.
- Haptics: selection on each step, success on launch, error on failure.

## 5. Tests
- Command construction: argv quoting, env prefixes, each built-in agent, a custom agent — ported
  from the web tests.
- Two-stage launch orchestration: session created, then command typed; failure between the two
  produces the honest state.
- Pending-launch persistence survives a simulated app restart and is abandoned cleanly when stale.
- Folder picker: directories only, dot-dirs hidden by default, case-insensitive sort, ≤12 pages
  drained, recents loaded from the API.
- Ceiling predicates block a launch into a full tab; telemetry does not.

## 6. Deliverables checklist
- [ ] Host → folder → agent → name flow, cancellable throughout
- [ ] Phone-shaped folder picker with recents, drill-down and path entry
- [ ] Two-stage agent launch with persisted pending command
- [ ] Ported command-construction logic and tests
- [ ] Shell handoff
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-10.md`; report `docs/native/reports/P2-10.md` with the exported
component/hook API for `P2-04`.
