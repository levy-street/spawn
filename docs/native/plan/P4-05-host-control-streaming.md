# P4-05 — Host-control capabilities and streaming

**Phase 4 (defect-fix pass), parallel with four other agents.** This is the largest Phase 4 item;
pace yourself and keep your progress file current.

**Read first:** `00-OVERVIEW.md` (§3 D4, §5, §7.4, §8), then `research/11-files-and-preview.md`
§1 and §TL;DR 5, `docs/native/plan/P1-09-terminal-core.md` §5, and
`docs/native/reports/P3-06-parity.md` "Top risks" item **8**.

## 1. The problem

> "Host-control transport is too narrow for shipped Files UI. It supports unary requests but not
> capabilities or streams (`mobile/src/terminal/transport/types.ts:150`). Preview/download/upload/
> transfer behavior can be disabled, hang, or fail differently across daemon versions."

`P2-07` shipped a Files UI whose transfer paths need streaming and capability negotiation that
`HostTransport` does not provide. Listing may work while transfers hang.

## 2. Files you own

```
mobile/src/terminal/transport/host-transport.ts
mobile/src/terminal/transport/types.ts            # HostTransport-related types only
mobile/src/terminal/transport/host-ctl-codec.ts   # new, if needed
mobile/src/terminal/worker/                       # host-control worker paths only
mobile/assets/terminal/                           # regenerate if the worker changes
mobile/src/**/__tests__/**  (yours only)
```

**Do not change `SessionTransport`, `TerminalSurface`, or the session worker paths.** Terminals
work; do not put them at risk. If a change would touch shared worker code, isolate it so session
behaviour is provably unaffected, and say how in your report.

## 3. What to build

### 3.1 Capability negotiation

Query and expose what the connected daemon supports, so the UI can disable rather than hang.
Surface it as typed data on `HostTransport`; `P2-07`'s screens consume it (they cannot change —
publish the shape in your report so a later pass can adopt it).

### 3.2 Streaming

Per `research/11 §TL;DR 5`, host transfers are **8 KiB verified chunks, SHA-256, bounded
backpressure, a 60-second stream timeout, cancellation, atomic writes, and a hard 512 MiB limit.**
Implement streaming reads and writes with all of it.

Keep this protocol strictly separate from session uploads (`spawn.ctl`: 20 MiB, 48 KiB chunks) —
`research/11 §Scope` is explicit that their acknowledgement boundaries, chunk sizes, ceilings and
reconciliation differ. **Do not unify them behind one retry policy.**

### 3.3 Regenerate the worker asset

If the worker changes, regenerate `assets/terminal/` with the command `P1-09` documented, keep it
fully offline (no remote loads beyond the `https://spawn.local/` base sentinel), and confirm the
session path still passes its tests.

## 4. Rules
- No new dependencies.
- Session terminal behaviour must not regress. Run `P1-09`'s and `P2-05`'s suites before finishing
  and report the result.

## 5. Tests
- Capability negotiation: supported, unsupported and absent-field daemons.
- Streaming read/write: chunk boundaries at 8 KiB, SHA-256 verification, a corrupted chunk
  rejected, backpressure, 60s timeout, cancellation mid-stream, the 512 MiB ceiling.
- Atomic write semantics: an interrupted write does not leave a partial file visible.
- Session transport suites still pass unchanged.

## 6. Deliverables
- [ ] Capability negotiation exposed on `HostTransport`
- [ ] Streaming reads/writes with verification, backpressure, timeout, cancellation, ceiling
- [ ] Session paths provably unaffected
- [ ] Worker asset regenerated and still offline, if changed
- [ ] Tests green; typecheck + lint clean for your files
- [ ] Progress `docs/native/progress/P4-05.md`; report `docs/native/reports/P4-05.md` with the
      capability shape for `P2-07` to adopt
