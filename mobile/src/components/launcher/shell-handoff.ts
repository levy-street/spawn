const INTERRUPT = "\u0003";
export const SHELL_HANDOFF_POLL_MS = 700;
export const SHELL_HANDOFF_ATTEMPTS = 8;
export const SHELL_HANDOFF_INTERRUPTS = 4;

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

  for (let attempt = 0; attempt < SHELL_HANDOFF_ATTEMPTS; attempt += 1) {
    if (attempt < SHELL_HANDOFF_INTERRUPTS) terminal.sendInput(INTERRUPT);
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
