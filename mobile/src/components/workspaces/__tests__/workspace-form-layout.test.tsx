import { HeaderHeightContext } from "@react-navigation/elements";
import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren, ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

let mockKeyboardVisible = false;

jest.mock("react-native-keyboard-controller", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return {
      KeyboardAwareScrollView: ({
        children,
        contentContainerStyle,
        testID,
      }: {
        children: ReactNode;
        contentContainerStyle?: object;
        testID?: string;
      }) => (
        <MockView style={contentContainerStyle} testID={testID}>
          {children}
        </MockView>
      ),
      KeyboardStickyView: ({ children }: { children: ReactNode }) => (
        <MockView testID="keyboard-sticky-view">{children}</MockView>
      ),
      useKeyboardState: (selector: (state: { isVisible: boolean }) => boolean) =>
        selector({ isVisible: mockKeyboardVisible }),
    };
  })(),
}));

jest.mock("@/components/ui/dialog", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return {
      Dialog: ({
        children,
        contentStyle,
        visible,
      }: {
        children?: ReactNode;
        contentStyle?: object;
        visible: boolean;
      }) =>
        visible ? (
          <MockView style={contentStyle} testID="new-workspace-surface">
            {children}
          </MockView>
        ) : null,
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

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <HeaderHeightContext.Provider value={103}>{children}</HeaderHeightContext.Provider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function form() {
  return (
    <CreateWorkspaceDialog
      busy={false}
      onCreate={jest.fn()}
      onDismiss={jest.fn()}
      templates={[]}
      visible
    />
  );
}

describe("new workspace form layout", () => {
  beforeEach(() => {
    mockKeyboardVisible = false;
  });

  it("pins two equal-width actions with the standard footer geometry", async () => {
    const screen = await render(form(), { wrapper: Providers });
    const footer = screen.getByTestId("footer-actions");

    expect(footer.children).toHaveLength(2);
    expect(StyleSheet.flatten(footer.props["style"])).toMatchObject({
      gap: sizing.footer.actionGap,
      paddingBottom: METRICS.insets.bottom,
      paddingHorizontal: sizing.footer.horizontalPadding,
      paddingTop: sizing.footer.topPadding,
    });
    for (const action of footer.children) {
      if (typeof action === "string") throw new Error("Footer action wrapper was not rendered.");
      expect(StyleSheet.flatten(action.props["style"])).toMatchObject({
        flexBasis: 0,
        flexGrow: 1,
        minHeight: sizing.footer.actionHeight,
      });
    }
    expect(screen.getByTestId("create-workspace-cancel")).toHaveStyle({
      minHeight: sizing.control.button.default,
    });
    expect(screen.getByTestId("create-workspace-submit")).toHaveStyle({
      minHeight: sizing.control.button.default,
    });
    expect(screen.getByTestId("keyboard-sticky-view")).toBeTruthy();
    await screen.unmount();
  });

  it("removes the safe-bottom gap while the footer tracks an open keyboard", async () => {
    const screen = await render(form(), { wrapper: Providers });

    mockKeyboardVisible = true;
    await screen.rerender(<Providers>{form()}</Providers>);

    expect(StyleSheet.flatten(screen.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: sizing.footer.minimumBottomPadding,
    });
    await screen.unmount();
  });

  it("keeps cancel and trimmed-name submission behavior in the pinned footer", async () => {
    const onCreate = jest.fn();
    const onDismiss = jest.fn();
    const screen = await render(
      <CreateWorkspaceDialog
        busy={false}
        onCreate={onCreate}
        onDismiss={onDismiss}
        templates={[]}
        visible
      />,
      { wrapper: Providers },
    );

    await fireEvent.press(screen.getByTestId("create-workspace-submit"));
    expect(screen.getByText("Enter a workspace name.")).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByPlaceholderText("Workspace name"), "  Mobile build  ");
    await fireEvent.press(screen.getByTestId("create-workspace-submit"));
    expect(onCreate).toHaveBeenCalledWith({
      iconChoice: null,
      name: "Mobile build",
      templateId: null,
    });

    await fireEvent.press(screen.getByTestId("create-workspace-cancel"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
