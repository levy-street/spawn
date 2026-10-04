import { describe, expect, test } from "bun:test";
import { socketAcceptingInput, type TerminalInputSocket } from "./terminal-input";

function fakeSocket(dcOpen: boolean): TerminalInputSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    dcOpen,
    sent,
    sendBinary: (bytes) => {
      sent.push(new TextDecoder().decode(bytes));
      return true;
    },
  };
}

/** A keystroke handler built the way Terminal.tsx installs one: once, in an effect. */
function installHandler(
  socketRef: { current: TerminalInputSocket },
  displayOwnerRef: { current: boolean | null },
) {
  return (data: string): boolean => {
    const live = socketAcceptingInput(socketRef, displayOwnerRef);
    return live ? live.sendBinary(new TextEncoder().encode(data)) : false;
  };
}

describe("socketAcceptingInput", () => {
  test("a handler installed while the channel was closed types into the reopened one", () => {
    const closed = fakeSocket(false);
    const socketRef = { current: closed as TerminalInputSocket };
    const displayOwnerRef = { current: true as boolean | null };
    const onData = installHandler(socketRef, displayOwnerRef);

    expect(onData("Q")).toBe(false);

    // The ready render assigns the new socket before the effect re-runs.
    const reopened = fakeSocket(true);
    socketRef.current = reopened;
    expect(onData("Q")).toBe(true);
    expect(reopened.sent).toEqual(["Q"]);
    expect(closed.sent).toEqual([]);
  });

  test("a handler installed while the channel was open stops once it closes", () => {
    const open = fakeSocket(true);
    const socketRef = { current: open as TerminalInputSocket };
    const onData = installHandler(socketRef, { current: true });

    socketRef.current = fakeSocket(false);
    expect(onData("x")).toBe(false);
    expect(open.sent).toEqual([]);
  });

  test.each([null, false])("refuses input while display ownership is %p", (owner) => {
    const socket = fakeSocket(true);
    const displayOwnerRef = { current: owner as boolean | null };
    expect(socketAcceptingInput({ current: socket }, displayOwnerRef)).toBeNull();

    displayOwnerRef.current = true;
    expect(socketAcceptingInput({ current: socket }, displayOwnerRef)).toBe(socket);
  });
});
