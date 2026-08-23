# P2-06 — Hosts, agents, skills and Legion

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§5, §8), then `research/12-auth-and-flows.md §5-6` (host list and
detail, what actions actually exist, Legion), `research/10-realtime-and-alerts.md §3` (host control
and capabilities), `research/07-workspace-model.md` for agent definitions.

## 1. Objective

The Hosts tab root: which machines exist, their state and capacity, the agents and skills available
on them, and the fleet view (Legion).

## 2. Files you own

```
src/app/(tabs)/hosts/index.tsx
src/app/(tabs)/hosts/_layout.tsx
src/app/host/[id]/index.tsx
src/app/host/[id]/agents.tsx
src/app/(tabs)/hosts/legion.tsx
src/components/hosts/**
src/data/queries/hosts.ts
```

Host **files** are `P2-07` (you link to their route). Device trust settings are `P2-08`.

## 3. Specification

### 3.1 Host list and detail

Show every field the web host screens show (`research/12 §5`). Actions that genuinely exist:
**rename, remove, view files, view sessions, agent availability/install/update**.

`research/12 §TL;DR 7` is explicit: there is **no daemon restart, no daemon update, and no
daemon-log UI or API**. Do not build controls for them. If a control seems obviously missing, that
is the correct state of the product — note it in your report rather than inventing an endpoint.

- Presence and status from `P1-07`'s host selectors; `StatusDot` for online/offline.
- **Capacity**: the server exposes *bucketed* capacity, while *exact* capacity comes over the
  host-control DataChannel (`research/10 §TL;DR 7`). Show the server value by default; if
  `P1-09`'s `HostTransport` is connected for that host, show the exact figure. Never present a
  bucketed value as exact.
- Removal is destructive and revokes trust — `Confirm` with honest copy about what breaks.

### 3.2 Agents and skills

Agent definitions are **launch shortcuts, not process records** (`research/07 §TL;DR 3`). Show the
four built-ins (Claude Code, Codex, OpenCode, Aider Sonnet) plus custom definitions, with
availability per host and install/update actions where the API supports them.

### 3.3 Legion

`research/12 §TL;DR 9` recommends Legion **in v1** because it is the fleet/capacity surface. Build
it: the fleet rollup using `P1-07`'s selectors, per-host capacity, and whatever the legion endpoints
expose (`research/03`). Keep it a read-and-navigate surface; it is not a control panel.

## 4. Rules

- Do not open host transports speculatively. Connect a `HostTransport` only when a screen needs
  exact capacity or files, and release it on blur.
- Capability-gate every control on what the host/daemon reports (`research/06 §TL;DR 8`).

## 5. Tests
- List/detail render from fixture data; every documented field appears.
- Bucketed vs exact capacity: correct source chosen per transport state.
- Absent actions (restart/update/logs) are genuinely absent.
- Agent availability and install/update wiring.
- Legion rollups from selectors.

## 6. Deliverables checklist
- [ ] Host list + detail with all real fields and actions only
- [ ] Capacity with correct bucketed/exact sourcing
- [ ] Agents + skills with availability and install/update
- [ ] Legion fleet view
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-06.md`; report `docs/native/reports/P2-06.md`.
