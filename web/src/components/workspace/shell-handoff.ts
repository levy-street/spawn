import { agentDisplayName } from "@/components/icons/AgentIcon";
import type { TerminalHandle } from "@/components/terminal/Terminal";
import { confirm } from "@/components/ui/confirm";
import { type Session, sessions } from "@/lib/api";
import { sessionAtShell } from "@/lib/sessions";

/**
 * Typing a command into a pane means the shell has to be the thing reading the
 * keyboard. When an agent holds the foreground instead, a `cd` would just be a
 * message to the agent — so ask first, then interrupt it and wait for the
 * prompt to come back before typing.
 */

/** Ctrl-C: agents read the first as "cancel" and a later one as "quit". */
const INTERRUPT = "\u0003";
/** How often to re-read the session while waiting for the prompt. */
const POLL_MS = 700;
/** Gives the agent ~5s of interrupts and polling before we give up. */
const ATTEMPTS = 8;
/** Only the first few attempts send Ctrl-C; the rest just watch. */
const INTERRUPTS = 4;

export type ShellHandoffResult = "sent" | "cancelled" | "busy";

export async function runInShell({
  session,
  handle,
  command,
  purpose,
  onSession,
}: {
  session: Session;
  handle: TerminalHandle | null;
  /** Typed verbatim, then Enter. */
  command: string;
  /** Sentence-initial description of the UI action, e.g. "Changing folder". */
  purpose: string;
  /** Fresh session records seen while waiting, for the caller's cache. */
  onSession?: (session: Session) => void;
}): Promise<ShellHandoffResult> {
  if (!handle) return "cancelled";
  if (sessionAtShell(session)) {
    type(handle, command);
    return "sent";
  }

  const foreground = agentDisplayName(session.foreground_command);
  const proceed = await confirm({
    title: `Stop ${foreground} first?`,
    body: `${purpose} types a command at the shell prompt, and ${foreground} is holding this pane's keyboard. Stopping it interrupts whatever it is doing.`,
    confirmLabel: `Stop ${foreground}`,
    destructive: true,
  });
  if (!proceed) return "cancelled";

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt < INTERRUPTS) handle.sendInput(INTERRUPT);
    await delay(POLL_MS);
    const latest = await sessions.get(session.id).catch(() => null);
    if (!latest) continue;
    onSession?.(latest);
    if (latest.status !== "running") return "busy";
    if (sessionAtShell(latest)) {
      type(handle, command, { clearFirst: true });
      return "sent";
    }
  }
  return "busy";
}

/** What the caller shows when the foreground never handed the shell back. */
export function stillRunningMessage(session: Session, purpose: string): string {
  const foreground = agentDisplayName(session.foreground_command);
  return `${foreground} is still running in this pane. Quit it in the terminal, then try ${purpose.toLocaleLowerCase()} again.`;
}

function type(
  handle: TerminalHandle,
  command: string,
  { clearFirst = false }: { clearFirst?: boolean } = {},
): void {
  // A quitting agent leaves its whole screen behind, so wipe it before the
  // command lands — the command itself still types visibly, on a clean prompt.
  if (clearFirst) handle.sendInput("clear\n");
  handle.sendInput(`${command}\n`);
  requestAnimationFrame(() => handle.focus());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
