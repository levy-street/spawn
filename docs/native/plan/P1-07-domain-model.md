# P1-07 — Domain model, layout algebra, selectors and the query-key registry

**Phase 1, parallel with eight other agents.** You own the app's *meaning*: what a workspace, tab,
terminal and status actually are, and every computed value derived from them. The owner asked for
"centralised data with computed variables" — you are that.

**Read first:** `00-OVERVIEW.md` (§5, §7.6, §8), then `research/07-workspace-model.md` **in full**
(2,465 lines — the entity reference, status model, agent kinds, lifecycle flows, layout algebra and
derived values), then `research/02-web-architecture.md §3-5` (query keys, derived state) and
`research/06-feature-inventory.md §TL;DR 2` for the canonical hierarchy.

---

## 1. Objective

Ship the domain types, the LayoutV3 codec and tab/tile algebra, every pure selector the UI needs,
and the single query-key registry.

## 2. Files you own

```
src/data/types/*.ts              # domain types: workspace, tab, tile, session, host, agent, …
src/data/layout/layout-v3.ts     # LayoutV3 parse/serialise/validate
src/data/layout/tabs.ts          # tab algebra: add, rename, reorder, remove, active
src/data/layout/tiles.ts         # tile algebra: 24×24 grid, placement, move-to-tab, ordering
src/data/layout/mobile-order.ts  # the phone's list ordering ↔ desktop geometry mapping
src/data/selectors/session.ts    # status, activity, attention, agent identity, display name
src/data/selectors/workspace.ts  # rollups, counts, sort orders
src/data/selectors/host.ts       # presence, capacity, availability
src/data/selectors/agent.ts      # agent kind → display name, logo key, launch command
src/data/queryKeys.ts
src/data/**/__tests__/**
```

You do **not** own API schemas (`P1-05`), React Query hooks (Phase 2 per domain), realtime stores
(`P1-08`) or any component.

## 3. Specifications

### 3.1 The hierarchy — get this exactly right

From `research/07 §TL;DR 1-2`:

- A **workspace** is a UUID-backed server row.
- **Tabs, pane membership, pane order, file widgets, tab homes and desktop geometry all live
  inside one version-3 `layout` JSON value on that row.** Tabs and panes are *not* server tables
  and have *no* CRUD endpoints.
- Every tab or pane mutation is a whole-envelope `PATCH /api/workspaces/{id}` with **no revision
  or compare-and-swap field**.

That last point is a correctness hazard: two clients editing concurrently will clobber each other.
Model the layout value as immutable and expose pure transformations returning a new envelope, so
the mutation layer can always send a coherent whole. Document the clobber risk in your report;
do not invent an optimistic-concurrency scheme the server does not support.

A tile is either a live PTY **session** or a **file-browser widget**. Preserve both.

### 3.2 LayoutV3 codec and algebra

- Parse, validate and serialise the v3 envelope. Validate against
  `mobile/tests/fixtures/layout-v3-fixtures.json` (copied by `P0-01`).
- The grid is **24×24, minimum tile 4×4, maximum 16 tiles per tab**
  (`research/03 §Scope`: `server/spawn_server/grid.py:19-31`). Older prose saying 12×12 is stale.
- Capacity ceilings: **8 tabs** and **16 valid tiles per tab** (`research/07 §TL;DR 9`). Enforce
  them in the algebra and expose "can add?" predicates so the UI can disable controls instead of
  failing a mutation.
- Unknown/invalid tiles must be preserved, not dropped — a phone must never silently destroy
  geometry it does not render.

### 3.3 `mobile-order.ts` — the phone/desktop compatibility bridge

This is the subtlest module in the campaign. From `research/07 §TL;DR 7-8`:

- The phone renders each tab as a **reading-order list**, never the web's mobile grid.
- It must nonetheless **preserve every v3 tile rectangle and widget payload** so the desktop web
  client stays compatible on the same account.
- There is **no independent list-order field**. So explicit reordering on the phone *necessarily*
  rewrites desktop geometry. The reference helper stacks up to six rows and otherwise reassigns
  existing rectangles.

Implement:
```ts
/** Deterministic reading order for a tab's tiles: the order the phone lists them. */
export function readingOrder(tab: WorkspaceTab): Tile[];
/** Rewrites geometry so `tiles` end up in the given order, preserving payloads. */
export function applyMobileOrder(tab: WorkspaceTab, orderedIds: string[]): WorkspaceTab;
```
`readingOrder` must be a pure function of geometry (top-to-bottom, then left-to-right, with a
documented tie-break) so the same workspace lists identically on every device. Test it against the
layout fixtures.

### 3.4 Status and activity — five independent dimensions

`research/07 §TL;DR 5` is emphatic: **process status, activity status, host presence, terminal
transport state and alerts are independent. Never overwrite one with another.** Model them as
separate fields and compute a display state from all five.

Activity is **server-derived** (`research/07 §TL;DR 6`), with these exact rules:
- output within ≤3s → `active`
- user input newer than output → `input-sent`
- output ≥8s old → `awaiting input`
- between those → `quiet`
- no output at all → `quiet` after 8s

Attention precedence: **a dead process outranks waiting.** Implement
`attentionRank(session): number` and `displayStatus(session, host, transport): DisplayStatus` as
pure functions with exhaustive tests — every screen depends on them agreeing.

### 3.5 Agent identity — what the terminal row shows

The owner asked that each terminal row show "type, name, logo, status". From
`research/07 §TL;DR 3-4`:

- **Type** derives from the daemon-reported `foreground_command`, *not* from the agent definition
  that launched it. Agent definitions are launch shortcuts, not running-process records.
- **Name** is `session.name`.
- **Logo** comes from the recognised kind; the four built-ins are **Claude Code, Codex, OpenCode,
  Aider Sonnet**. Custom definitions exist, and unknown kinds/commands fall back to a
  **first-letter monogram** (rendered by `P1-01`'s `Monogram`).

Implement `identifyAgent(foregroundCommand: string | null, agents: AgentDef[]): AgentIdentity`
returning `{ kind, displayName, logoKey | null, monogramSeed }`. Port the web app's matching logic
faithfully — `research/07` documents it, including argv handling. Exhaustive tests: each built-in,
a custom definition, an unknown command, a null command, and commands with paths/args/env prefixes.

### 3.6 Selectors

Pure functions only, no React, no hooks, no cache access. Cover the derived values
`research/07 §6` and `research/02 §5` enumerate: per-tab running counts, per-workspace rollups,
sort orders, the active session, unread/activity indicators, capacity remaining, badge counts,
host presence and availability, fleet rollups.

Each selector takes plain data and returns plain data. Phase 2 wraps them in `useMemo`.

### 3.7 `queryKeys.ts`

Transcribe the complete registry from `research/02 §4` — `me`, `auth-config`, `hosts`, `host`,
`sessions`, `session`, `workspaces`, `workspace`, `workspace-templates`, `agents`, `skills`, plus
the scoped trust/browser-device/file/admin keys. Shape per `00-OVERVIEW.md §7.6`: functions
returning `as const` tuples, so keys are typed and greppable.

Include the invalidation groupings the web app relies on (list + detail written together —
`research/02 §5`) as documented helpers, e.g. `qk.sessionAll(id)` returning the pair, so Phase 2
agents invalidate consistently rather than each inventing a convention.

## 4. Rules specific to you

- **Pure.** No React, no network, no storage, no side effects anywhere in this agent's output.
- Wire types come from `P1-05`'s zod schemas — import them rather than redeclaring. Domain types
  that genuinely differ from the wire (computed unions, display states) are yours.
- Keep wire field names `snake_case` when passing wire data through; do not build a renaming layer.
- Do not implement mutations, hooks or optimistic updates. You provide the algebra they use.

## 5. Tests

This agent is almost entirely testable, so the bar is high.
- LayoutV3: parse/serialise round-trip against every case in `layout-v3-fixtures.json`; invalid
  envelopes rejected; unknown tiles preserved.
- Tab/tile algebra: add/rename/reorder/remove; the 8-tab and 16-tile ceilings; move-to-tab
  preserving payloads; placement on a 24×24 grid with the 4×4 minimum.
- `readingOrder` determinism and tie-breaks; `applyMobileOrder` preserving every payload and
  producing the requested order.
- `displayStatus` and `attentionRank`: a truth table over all five dimensions, including the
  dead-process-outranks-waiting rule.
- Activity derivation at the 3s and 8s boundaries (fake clock).
- `identifyAgent`: all four built-ins, custom, unknown, null, argv/env-prefixed forms.
- Every selector with representative and empty inputs.
- Query keys: stable, unique, and typed (`as const`).

## 6. Deliverables checklist

- [ ] Domain types covering the full hierarchy including file widgets
- [ ] LayoutV3 codec validated against the fixtures, unknown tiles preserved
- [ ] Tab/tile algebra with 8-tab and 16-tile ceilings and `can*` predicates
- [ ] `mobile-order.ts` bridging phone list order and desktop geometry
- [ ] Five-dimension status model with `displayStatus` and `attentionRank`
- [ ] `identifyAgent` with built-ins, custom, and monogram fallback
- [ ] Complete selector set
- [ ] Complete query-key registry with invalidation groupings
- [ ] All suites green; `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-07.md`. Final report: `docs/native/reports/P1-07.md` with the
full type list, every exported selector and its signature, the query-key registry as shipped, the
concurrent-`PATCH` clobber risk written up plainly, `## Requests for other agents`, `## Known gaps`.
