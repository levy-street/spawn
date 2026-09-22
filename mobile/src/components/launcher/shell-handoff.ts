const INTERRUPT = "\u0003";
export const SHELL_HANDOFF_POLL_MS = 700;
export const SHELL_HANDOFF_ATTEMPTS = 8;
/** Polls that each carry a Ctrl-C at the start. */
export const SHELL_HANDOFF_INTERRUPTS = 4;
/** Every this-many polls after that, a pair of Ctrl-Cs. */
export const SHELL_HANDOFF_INTERRUPT_PERIOD = 8;

/**
 * When, while waiting for an agent to hand the prompt back, the handoff sends
 * it another Ctrl-C. Agents read the first as "cancel" and a second one soon
 * after as "quit", so the first polls each carry one. An agent that ate that
 * opening pair — a menu was open, a permission prompt had the keyboard, the
 * machine was busy — gets a fresh pair every eighth poll after that, rather
 * than the handoff falling silent and timing out into a restart of the whole
 * shell. Once the agent has quit the extra presses land on a shell prompt,
 * which ignores them, and the `clear` typed ahead of the command wipes them.
 */
export function interruptScheduled(attempt: number): boolean {
  if (attempt < SHELL_HANDOFF_INTERRUPTS) return true;
  return attempt % SHELL_HANDOFF_INTERRUPT_PERIOD < 2;
}

export interface HandoffSession {
  id: string;
  status: string;
  foreground_command: string | null;
}

export interface ShellCommandSink {
  sendInput(data: string): void;
  focus(): void;
}

export type ShellHandoffResult = "sent" | "cancelled" | "busy";

export function sessionAtShell(session: Pick<HandoffSession, "foreground_command">): boolean {
  const foreground = session.foreground_command?.trim().replace(/^-/, "").toLocaleLowerCase();
  return !foreground || ["bash", "zsh", "fish", "sh", "dash"].includes(foreground);
}

function foregroundName(session: Pick<HandoffSession, "foreground_command">): string {
  return session.foreground_command?.trim().replace(/^-/, "") || "agent";
}

function typeCommand(terminal: ShellCommandSink, command: string, clearFirst = false): void {
  if (clearFirst) terminal.sendInput("clear\n");
  terminal.sendInput(`${command}\n`);
  terminal.focus();
}

export async function runInShell({
  session,
  terminal,
  command,
  purpose,
  confirmStop,
  getSession,
  onSession,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = SHELL_HANDOFF_ATTEMPTS,
}: {
  session: HandoffSession;
  terminal: ShellCommandSink | null;
  command: string;
  purpose: string;
  confirmStop(input: {
    title: string;
    description: string;
    confirmLabel: string;
  }): Promise<boolean>;
  getSession(sessionId: string): Promise<HandoffSession>;
  onSession?: (session: HandoffSession) => void;
  wait?: (milliseconds: number) => Promise<void>;
  /** How many polls the agent gets to quit before it is reported still running. */
  attempts?: number;
}): Promise<ShellHandoffResult> {
  if (!terminal) return "cancelled";
  if (sessionAtShell(session)) {
    typeCommand(terminal, command);
    return "sent";
  }

  const foreground = foregroundName(session);
  const proceed = await confirmStop({
    title: `Stop ${foreground} first?`,
    description: `${purpose} types a command at the shell prompt, and ${foreground} is holding this window's keyboard. Stopping it interrupts whatever it is doing.`,
    confirmLabel: `Stop ${foreground}`,
  });
  if (!proceed) return "cancelled";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (interruptScheduled(attempt)) terminal.sendInput(INTERRUPT);
    await wait(SHELL_HANDOFF_POLL_MS);
    const latest = await getSession(session.id).catch(() => null);
    if (!latest) continue;
    onSession?.(latest);
    if (latest.status !== "running") return "busy";
    if (sessionAtShell(latest)) {
      typeCommand(terminal, command, true);
      return "sent";
    }
  }
  return "busy";
}

export function stillRunningMessage(session: HandoffSession, purpose: string): string {
  const foreground = foregroundName(session);
  return `${foreground} is still running in this window. Quit it in the terminal, then try ${purpose.toLocaleLowerCase()} again.`;
}
