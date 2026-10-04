/** What a keystroke needs from the session socket. */
export interface TerminalInputSocket {
  readonly dcOpen: boolean;
  sendBinary(bytes: Uint8Array): boolean;
}

/**
 * The socket a keystroke goes to, read when the keystroke arrives; null while
 * this pane may not type (not the display owner, or the channel is closed).
 *
 * It takes refs, never the socket itself. xterm's `onData` handler is
 * installed in an effect, and the render that marks the terminal ready
 * (`aria-busy="false"`) commits before any effect re-runs. A handler that
 * tested the socket it closed over still saw the closed one, and dropped
 * whatever was typed in that gap: after a reattach, or after the tab that
 * held the connection closed and this one took over. The socket ref is
 * assigned during render, so it already holds the socket that render
 * committed.
 */
export function socketAcceptingInput<S extends TerminalInputSocket>(
  socketRef: { readonly current: S },
  displayOwnerRef: { readonly current: boolean | null },
): S | null {
  const socket = socketRef.current;
  return displayOwnerRef.current === true && socket.dcOpen ? socket : null;
}
