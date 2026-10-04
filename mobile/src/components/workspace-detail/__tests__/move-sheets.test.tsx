import { fireEvent, render as renderBare } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as copy from "@/components/workspace-detail/move-copy";
import {
  MoveConfirmSheet,
  MoveProgressSheet,
  MoveResolveSheet,
  moveActionLabel,
  moveStepLine,
} from "@/components/workspace-detail/move-sheets";

jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { View } = jest.requireActual<typeof import("react-native")>("react-native");
    return visible ? React.createElement(View, null, children) : null;
  },
}));
jest.mock("@/components/ui/action-sheet", () => ({ ActionSheet: () => null }));

import { ThemeProvider } from "@/theme";

const names = { from: "dream", to: "mac" };

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function render(node: ReactElement) {
  return renderBare(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{node}</ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe("the Move dialog", () => {
  it("checks both hosts first", async () => {
    const screen = await render(
      <MoveConfirmSheet
        onCancel={jest.fn()}
        onMove={jest.fn()}
        onStartFresh={jest.fn()}
        state={{ kind: "checking", from: "dream", to: "mac" }}
        toName="mac"
        visible
      />,
    );
    expect(screen.getByText("Checking dream and mac…")).toBeTruthy();
    // The checking state has its header too.
    expect(screen.getByText("Move Claude Code to mac?")).toBeTruthy();
    expect(screen.queryByText(copy.MOVE_WITH_CONVERSATION)).toBeNull();
  });

  it("a source offline asks whether to start fresh on the target", async () => {
    const onStartFresh = jest.fn();
    const screen = await render(
      <MoveConfirmSheet
        onCancel={jest.fn()}
        onMove={jest.fn()}
        onStartFresh={onStartFresh}
        state={{
          kind: "blocked",
          reason: copy.moveSourceOffline("dream", "mac"),
          startFresh: "on_target",
        }}
        toName="mac"
        visible
      />,
    );
    expect(screen.getByText(copy.moveSourceOffline("dream", "mac"))).toBeTruthy();
    expect(screen.queryByText(copy.MOVE_WITH_CONVERSATION)).toBeNull();
    fireEvent.press(screen.getByText("Start fresh on mac"));
    expect(onStartFresh).toHaveBeenCalled();
  });

  it("a missing folder blocks the carry and offers only a fresh start", async () => {
    const reason = copy.moveFolderMissing("mac", "~/code/spawn");
    const screen = await render(
      <MoveConfirmSheet
        onCancel={jest.fn()}
        onMove={jest.fn()}
        onStartFresh={jest.fn()}
        state={{ kind: "blocked", reason, startFresh: "instead" }}
        toName="mac"
        visible
      />,
    );
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText(copy.MOVE_START_FRESH)).toBeTruthy();
    expect(screen.queryByText(copy.MOVE_WITH_CONVERSATION)).toBeNull();
  });
});

describe("the progress sheet", () => {
  it("names the step and the bytes, with Cancel until the target commits", async () => {
    const onCancel = jest.fn();
    const screen = await render(
      <MoveProgressSheet
        busy={false}
        cancellable
        names={names}
        onAction={jest.fn()}
        onCancel={onCancel}
        onHide={jest.fn()}
        phase={{ step: "copying", sent: 3_100_000, total: 12_400_000 }}
        visible
      />,
    );
    expect(screen.getByText("Moving to mac…")).toBeTruthy();
    expect(screen.getByText("Copying the conversation · 3.0 of 11.8 MB")).toBeTruthy();
    expect(screen.getByTestId("move-progress-bar").props["accessibilityValue"]).toEqual({
      min: 0,
      max: 100,
      now: 25,
    });
    expect(screen.getByText(copy.MOVE_KEEP_OPEN)).toBeTruthy();
    fireEvent.press(screen.getByText(copy.MOVE_CANCEL));
    expect(onCancel).toHaveBeenCalled();
  });

  it("a held failure offers Try again and Resume on the source", async () => {
    const onAction = jest.fn();
    const screen = await render(
      <MoveProgressSheet
        busy={false}
        cancellable
        names={names}
        onAction={onAction}
        onCancel={jest.fn()}
        onHide={jest.fn()}
        phase={{
          step: "failed",
          failure: {
            message: copy.moveBackground("dream"),
            detail: null,
            actions: ["retry", "resume_source"],
            held: true,
          },
        }}
        visible
      />,
    );
    expect(screen.getByText(copy.moveBackground("dream"))).toBeTruthy();
    fireEvent.press(screen.getByText("Resume on dream"));
    expect(onAction).toHaveBeenCalledWith("resume_source");
  });

  it("says each step as the browser does", () => {
    expect(moveStepLine({ step: "stopping" }, names)).toBe("Stopping Claude Code on dream…");
    expect(moveStepLine({ step: "starting" }, names)).toBe("Starting on mac…");
    expect(moveStepLine({ step: "restoring" }, names)).toBe(
      "Putting the conversation back on dream…",
    );
    expect(moveActionLabel("start_fresh", "dream", "mac")).toBe("Start fresh on mac");
    expect(moveActionLabel("give_up", "dream", "mac")).toBe("Give up the move");
    expect(moveActionLabel("take_there", "dream", "mac")).toBe("Take the window to mac");
  });

  it("putting it back is a step of its own, with no Cancel to press", async () => {
    const screen = await render(
      <MoveProgressSheet
        busy={false}
        cancellable
        names={names}
        onAction={jest.fn()}
        onCancel={jest.fn()}
        onHide={jest.fn()}
        phase={{ step: "restoring" }}
        visible
      />,
    );
    expect(screen.getByText("Putting the conversation back on dream…")).toBeTruthy();
    expect(screen.getByText(copy.MOVE_CANCEL)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: copy.MOVE_CANCEL }).props["accessibilityState"],
    ).toMatchObject({ disabled: true });
  });
});

describe("Resolve", () => {
  const props = {
    canGiveUp: true,
    onDismiss: jest.fn(),
    onGiveUp: jest.fn(),
    onResolve: jest.fn(),
    sourceName: "dream",
    visible: true,
  };

  it("asks before it acts, and says what it will do", async () => {
    const onResolve = jest.fn();
    const screen = await render(
      <MoveResolveSheet {...props} onResolve={onResolve} state={{ kind: "confirm" }} />,
    );
    expect(screen.getByText("Finish or put back this move?")).toBeTruthy();
    expect(
      screen.getByText(
        "This window started moving from dream and didn't finish. SPAWN D will ask dream and the host it was going to where the conversation is, then finish the move or put it back.",
      ),
    ).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(copy.MOVE_RESOLVE));
    expect(onResolve).toHaveBeenCalled();
  });

  it("says whom it is asking while it works", async () => {
    const screen = await render(<MoveResolveSheet {...props} state={{ kind: "resolving" }} />);
    expect(screen.getByText("Checking dream…")).toBeTruthy();
  });

  it("a host that cannot answer offers Give up, saying what it leaves", async () => {
    const onGiveUp = jest.fn();
    const giveUp = copy.moveGiveUpBody("dream", null);
    const screen = await render(
      <MoveResolveSheet
        {...props}
        onGiveUp={onGiveUp}
        state={{
          kind: "outcome",
          outcome: {
            kind: "unreachable",
            message: copy.moveResolveSourceOffline("dream"),
            giveUp,
          },
        }}
      />,
    );
    expect(screen.getByText(copy.moveResolveSourceOffline("dream"))).toBeTruthy();
    expect(screen.getByText(giveUp)).toBeTruthy();
    fireEvent.press(screen.getByText("Give up the move"));
    expect(onGiveUp).toHaveBeenCalled();
  });

  it("no Give up once the target took the conversation, or for a window not moving", async () => {
    const screen = await render(
      <MoveResolveSheet
        {...props}
        state={{
          kind: "outcome",
          outcome: { kind: "unreachable", message: copy.moveCommitOffline("mac"), giveUp: null },
        }}
      />,
    );
    expect(screen.queryByText("Give up the move")).toBeNull();
    const notMoving = await render(
      <MoveResolveSheet
        {...props}
        canGiveUp={false}
        state={{
          kind: "outcome",
          outcome: {
            kind: "unreachable",
            message: copy.moveResolveSourceOffline("dream"),
            giveUp: copy.moveGiveUpBody("dream", null),
          },
        }}
      />,
    );
    expect(notMoving.queryByText("Give up the move")).toBeNull();
  });
});
