# ADR: mandatory session workers and tmux removal

Status: **accepted, independently reviewed, and merged for P2-TMUX-01**
(`1f66d2d`, 2026-07-15).

## Decision

`spawn-worker` is the only production session backend. `spawnd` always
creates and adopts workers; there is no global selector, per-session override, or
fallback. Failure to launch/connect/adopt a worker fails closed. The daemon no
longer executes the `tmux` binary or contains creation, attach, discovery,
adoption, naming, capture, replay, resize, scroll, copy-mode, or repaint logic
for tmux sessions.

This checkpoint also removes the tmux-only exact replay buffer and status-bar
classifier. Replay now has one source: the worker's encrypted bounded log and
checkpoint emulator. The daemon keeps only routing watermarks needed to order
that replay against a viewer's direct stream.

No new tmux fixes, compatibility features, or fallback paths are permitted.
Remaining tmux references belong only in historical/migration documentation.
`scripts/check-worker-only-daemon.sh`, run by `scripts/test-all.sh`, rejects
reintroduction in daemon code, tests, dependency metadata, selectors, or
protocol structs.

### Maintenance rule: do not revive tmux

A bug report against the retired tmux backend is not a tmux repair task. Close
it as obsolete or restate the user-visible behavior against `spawn-worker`.
Do not add tmux dependencies, commands, socket discovery, adapters, fixtures,
feature flags, service configuration, or compatibility tests. The normal fix
path is the worker-only implementation. Any proposal to reverse this decision
requires a new ADR, an explicit trust-boundary review, and replacement of the
worker-only source guard; incident response is not an exception.

## Cutover boundary

There is deliberately no transparent migration of a live tmux PTY into a
worker. Terminal state, process ownership, job-control state, and replay
coordinates cannot be transferred safely without observing or corrupting the
protected content.

Before installing the worker-only daemon, an operator must:

1. close new-session ingress and announce the drain window;
2. inventory old sessions without capturing pane content;
3. let users finish or explicitly terminate those sessions under the normal
   operator change procedure;
4. verify no old session remains, then install both new binaries and restart
   `spawnd`;
5. verify new sessions create worker sockets and worker-backed replay; and
6. perform the later P2-PURGE-01 host/process/backups purge checks.

This repository change does not deploy, restart services, signal sessions, or
delete external sessions. If an old session is still present after upgrade,
the new daemon reports it unavailable and does not inspect or adopt it.

## Failure and rollback semantics

- Worker binary missing, version-skewed, or unreachable: creation/adoption
  fails closed; no alternate content path is attempted.
- Supervisor restart: compatible live workers remain authoritative and are
  adopted from their Unix sockets.
- Worker restart/crash: its PTY and ephemeral replay key are gone; recovery is
  a user-driven new session, not content reconstruction.
- Rollback: rolling back the supervisor binary must not restore a tmux content
  path or make old session content reachable. Operational rollback means stop
  the change, retain/drain compatible workers, and roll forward with a corrected
  worker-only build. Reintroducing the retired backend requires a new reviewed
  ADR and is not an incident shortcut.

## Protocol removal

The server/API/web `tmux_session` display field and `agent.rename` daemon frame
are removed in the same checkpoint. Although the field was computed rather
than persisted, its friendly label could derive from protected session/cwd naming
and therefore was not safe compatibility metadata. No new writes or derived
values are allowed. P2-PURGE-01 still covers historical logs, caches, backups,
and other recoverable copies outside the live schema.

The follow-on P2-AGENT-02 checkpoint removes the legacy `spawn.v1` WebSocket,
binary `0x01` output mirror, `0x02` input leg, and server transcript/history
relay. It does not weaken this ADR: tmux remains retired and must not be
reintroduced as a compatibility, replay, fallback, or incident-recovery path.
The only accepted direction is worker-only, mandatory-DataChannel roll-forward.
