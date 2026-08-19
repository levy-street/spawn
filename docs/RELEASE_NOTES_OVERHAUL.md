# Workspace/session overhaul — internal upgrade notes

This release replaces the old multi-page process launcher with a shell-first
workspace product.

## What changes in the product

- The signed-in product now has one main page: a workspace containing a packed
  grid of terminal sessions.
- The left sidebar is a workspace → session tree. It creates, reorders,
  renames, and removes workspaces and exposes session actions.
- New accounts use a guided account → email verification (when required) →
  host connection → first workspace flow.
- Account, appearance, hosts, agent definitions, skills, browser devices, and
  device trust now live in the Settings dialog.
- Every session starts the host user's login shell in a selected directory.
  Agents are CLI definitions shown as shortcuts at an empty shell prompt; a
  shortcut types its visible command into the PTY. Exiting or interrupting the
  CLI returns to the shell.
- Workspaces use a packed 12×12 grid with up to eight session tiles. Desktop
  supports drag, resize, and zoom; mobile uses the same sessions in reading
  order as a vertical stack.

## Required upgrade order

Upgrade in this order:

1. **Apply database migrations 0029–0032.** They rename and convert the stored
   objects before the new application reads them.
2. **Deploy the server and web app together.** Their REST objects, web routes,
   browser signaling protocol, and vocabulary are one contract.
3. **Upgrade every host daemon.** Daemon protocol v3 is intentionally a clean
   break after the control plane is ready for it.

Do not mix the new web app with an old server or put a v3 daemon in front of a
server that still expects the earlier control protocol.

## Daemon upgrade

A daemon that has not yet been upgraded is rejected by the v3 control socket
and appears **offline**. On each host, re-run the installer from your
deployment:

```bash
curl -fsSL https://spawn.example.com/install.sh | sh
```

Running PTYs survive this daemon upgrade. Each PTY belongs to a separate
`spawn-worker` process in its own process group, not to the `spawnd` supervisor.
The new supervisor discovers the existing worker sockets and adopts them. The
private worker wire stays at version 5, and its `Hello` decoder accepts the
pre-overhaul session-identity key used by an already-running worker. Such a
worker simply does not provide the newly added foreground-process report.

The service definition deliberately restarts only `spawnd`; do not replace it
with a service-manager policy that kills the worker processes at the same
time.

## Preserved data

The migrations preserve:

- accounts;
- hosts, daemon pairings, and host ownership;
- browser devices, trust bundles, passkeys, endorsements, and host/browser
  trust state;
- skills and grants for sessions that are retained;
- active and exited session records;
- workspaces, with their split-tree layouts converted to packed grid layouts;
  and
- built-in and custom agent definitions, converted from the former CLI
  definition records to the new `{command, env, install}` shape.

Recent working directories are backfilled from the surviving sessions so the
new-session location menu is useful immediately.

## Deliberate deletions

The following data is not preserved:

- archived agents (the former process records) and their skill grants;
- the built-in `shell` CLI shortcut, because every session is already a shell;
- session pin state; and
- the former ephemeral and pinned screen concepts and their stored flags.

These are product deletions, not migration failures.

## One-time restart behavior

A session migrated from a pre-overhaul process record keeps running whatever
it was already running. The new daemon adopts that worker without replacing
its PTY.

If that migrated session is restarted, it now starts a **login shell** in its
stored directory. It does not relaunch the CLI that the old record originally
started. This is the intended shell-first session behavior, not a bug; launch
the desired CLI from the agent shortcut or the shell prompt.

## Rollback limits

Migrations 0029–0032 each implement `downgrade()`, so the schema can be rolled
back in reverse order. A rollback must also coordinate the server, web app,
and daemon protocol versions; an incompatible daemon will remain offline.

Downgrade is not a backup restore. It cannot recover archived records or their
grants, original pin/ephemeral values, or policies attached to the deleted
built-in shell definition. Grid layouts are converted back to a usable
reading-order split tree, not their exact former geometry, and the old launch
columns cannot reconstruct every original launch value. Restore a pre-upgrade
database backup if any deliberately deleted value is required.
