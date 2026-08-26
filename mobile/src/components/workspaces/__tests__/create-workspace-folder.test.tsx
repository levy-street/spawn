import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { ThemeProvider } from "@/theme";

const HOST_ID = "00000000-0000-4000-8000-0000000000cc";
const FOLDER = "/Users/charlie/dev/spawn";

jest.mock("@/components/ui/dialog", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return {
      Dialog: ({ children, visible }: { children?: ReactNode; visible: boolean }) =>
        visible ? <MockView>{children}</MockView> : null,
    };
  })(),
}));

jest.mock("@/components/ui/select", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return { Select: () => <MockView testID="workspace-template-select" /> };
  })(),
}));

jest.mock("@/components/workspaces/workspace-icon-picker", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return { WorkspaceIconPicker: () => <MockView testID="workspace-icon-picker" /> };
  })(),
}));

// The real sheet browses a machine over a live transport; what matters here is
// that what it hands back reaches the workspace.
jest.mock("@/components/workspaces/workspace-folder-sheet", () => ({
  ...(() => {
    const { Pressable: MockPressable, Text: MockText } =
      require("react-native") as typeof import("react-native");
    return {
      WorkspaceFolderSheet: ({
        visible,
        onPick,
      }: {
        visible: boolean;
        onPick: (folder: { hostId: string; hostName: string; path: string }) => void;
      }) =>
        visible ? (
          <MockPressable
            onPress={() => onPick({ hostId: HOST_ID, hostName: "dream", path: FOLDER })}
            testID="pick-folder"
          >
            <MockText>Pick a folder</MockText>
          </MockPressable>
        ) : null,
    };
  })(),
}));

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, right: 0, bottom: 34, left: 0 },
      }}
    >
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("choosing where a new workspace opens", () => {
  test("the chosen folder rides the draft out, named by its tail", async () => {
    const onCreate = jest.fn();
    await render(
      <CreateWorkspaceDialog
        busy={false}
        onCreate={onCreate}
        onDismiss={jest.fn()}
        templates={[]}
        visible
      />,
      { wrapper: Providers },
    );

    expect(screen.getByTestId("create-workspace-folder")).toBeOnTheScreen();
    expect(screen.getByText("Choose a folder")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("create-workspace-folder"));
    await fireEvent.press(screen.getByTestId("pick-folder"));

    // A full path does not fit on a phone, and its head is the part every
    // folder on a machine shares.
    expect(screen.getByText("…/dev/spawn")).toBeOnTheScreen();
    expect(screen.getByText("Opens on dream.")).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByPlaceholderText("Workspace name"), "Spawn");
    await fireEvent.press(screen.getByTestId("create-workspace-submit"));
    expect(onCreate).toHaveBeenCalledWith({
      folder: { hostId: HOST_ID, hostName: "dream", path: FOLDER },
      iconChoice: null,
      name: "Spawn",
      templateId: null,
    });
  });
});
