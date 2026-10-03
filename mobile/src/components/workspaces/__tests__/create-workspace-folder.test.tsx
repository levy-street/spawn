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

// Pressing the select picks its last option, which is enough to choose a template.
jest.mock("@/components/ui/select", () => ({
  ...(() => {
    const { Pressable: MockPressable } = require("react-native") as typeof import("react-native");
    return {
      Select: ({
        options,
        onChange,
      }: {
        options: { value: string }[];
        onChange: (value: string) => void;
      }) => (
        <MockPressable
          onPress={() => onChange(options[options.length - 1]?.value ?? "")}
          testID="workspace-template-select"
        />
      ),
    };
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

const TEMPLATE = {
  id: "template-1",
  name: "Review",
  host_id: null,
  cwd: null,
  icon: null,
  icon_source: null,
  created_at: "2026-08-20T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
  spec: {
    version: 2 as const,
    tabs: [
      { name: "Tab 1", tiles: [{ x: 0, y: 0, w: 24, h: 24, run: { kind: "shell" as const } }] },
    ],
  },
};
const SUGGESTED = { hostId: HOST_ID, hostName: "dream", path: "/home/oem/notes" };

describe("where a new workspace's windows run", () => {
  test("a blank workspace asks for no folder: each window it gets says where it runs", async () => {
    const onCreate = jest.fn();
    await render(
      <CreateWorkspaceDialog
        busy={false}
        onCreate={onCreate}
        onDismiss={jest.fn()}
        suggestedFolder={SUGGESTED}
        templates={[TEMPLATE]}
        visible
      />,
      { wrapper: Providers },
    );

    expect(screen.queryByTestId("create-workspace-folder")).toBeNull();
    await fireEvent.changeText(screen.getByPlaceholderText("Workspace name"), "Spawn");
    await fireEvent.press(screen.getByTestId("create-workspace-submit"));
    expect(onCreate).toHaveBeenCalledWith({
      folder: null,
      iconChoice: null,
      name: "Spawn",
      templateId: null,
    });
  });

  test("a template offers the likeliest place, and a picked folder replaces it", async () => {
    const onCreate = jest.fn();
    await render(
      <CreateWorkspaceDialog
        busy={false}
        onCreate={onCreate}
        onDismiss={jest.fn()}
        suggestedFolder={SUGGESTED}
        templates={[TEMPLATE]}
        visible
      />,
      { wrapper: Providers },
    );

    await fireEvent.press(screen.getByTestId("workspace-template-select"));
    expect(screen.getByText("…/oem/notes")).toBeOnTheScreen();
    expect(screen.getByText("On dream.")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("create-workspace-folder"));
    await fireEvent.press(screen.getByTestId("pick-folder"));
    // A full path does not fit on a phone, and its head is the part every
    // folder on a machine shares.
    expect(screen.getByText("…/dev/spawn")).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByPlaceholderText("Workspace name"), "Spawn");
    await fireEvent.press(screen.getByTestId("create-workspace-submit"));
    expect(onCreate).toHaveBeenCalledWith({
      folder: { hostId: HOST_ID, hostName: "dream", path: FOLDER },
      iconChoice: null,
      name: "Spawn",
      templateId: "template-1",
    });
  });
});
