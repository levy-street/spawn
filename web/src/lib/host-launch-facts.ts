/**
 * What a host says, in the hello of this device's connection to it, about
 * starting agents there (`agents`, proto/README.md): today, whether the
 * `codex` its user's shells find accepts `--no-daemon`. The daemon learns it
 * by running `codex --no-daemon --version` itself; a client never guesses.
 *
 * `--no-daemon` keeps a Codex window's threads in that window's own process
 * rather than Codex's shared background server, where the host cannot tell
 * which thread a window is on, so a later restart can come back to it. A
 * Codex that does not know the flag refuses to start, so it is typed only
 * where the host said yes: an older daemon, a host not heard from yet, or a
 * Codex that refuses it means no flag.
 *
 * Kept per host for the page's life, replaced by each hello from that host's
 * device connection (a host that went offline still has the Codex it had).
 */

export interface HostLaunchFacts {
  /** The host's `codex` accepts `--no-daemon`. */
  readonly codexNoDaemon: boolean;
}

/** What a client assumes of a host that has said nothing. */
export const NO_LAUNCH_FACTS: HostLaunchFacts = Object.freeze({ codexNoDaemon: false });

const known = new Map<string, HostLaunchFacts>();

/** The `agents` object of a hello, read field by field: anything but an
 *  explicit `true` is no. */
export function parseHostLaunchFacts(agents: unknown): HostLaunchFacts {
  if (!agents || typeof agents !== "object") return NO_LAUNCH_FACTS;
  const codex = (agents as Record<string, unknown>).codex;
  const noDaemon =
    !!codex && typeof codex === "object" && (codex as Record<string, unknown>).no_daemon === true;
  return noDaemon ? Object.freeze({ codexNoDaemon: true }) : NO_LAUNCH_FACTS;
}

/** A hello from `hostId`'s device connection said `facts`. */
export function recordHostLaunchFacts(hostId: string, facts: HostLaunchFacts): void {
  known.set(hostId, facts);
}

/** What `hostId` last said, or nothing. */
export function hostLaunchFacts(hostId: string | null | undefined): HostLaunchFacts {
  return (hostId && known.get(hostId)) || NO_LAUNCH_FACTS;
}

/** Forget every host (tests). */
export function forgetHostLaunchFacts(): void {
  known.clear();
}
