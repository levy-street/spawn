/**
 * When, while waiting for an agent to hand the prompt back, the handoff sends
 * it another Ctrl-C.
 *
 * Agents read the first Ctrl-C as "cancel" and a second one soon after as
 * "quit", so the first polls each carry one. An agent that ate that opening
 * pair — a menu was open, a permission prompt had the keyboard, the machine
 * was busy — gets a fresh pair every eighth poll after that, rather than the
 * handoff falling silent and timing out into a restart of the whole shell.
 * Once the agent has quit the extra presses land on a shell prompt, which
 * ignores them, and the `clear` typed ahead of the command wipes the echoes.
 */

/** Polls that each carry a Ctrl-C at the start. */
export const OPENING_INTERRUPTS = 4;
/** Every this-many polls after that, a pair of Ctrl-Cs. */
export const INTERRUPT_PERIOD = 8;

export function interruptScheduled(attempt: number): boolean {
  if (attempt < OPENING_INTERRUPTS) return true;
  return attempt % INTERRUPT_PERIOD < 2;
}
