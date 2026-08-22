import { fireEvent, render } from "@testing-library/react-native";
import type { ReactElement } from "react";

import { WorkspaceHeader } from "@/components/workspace-detail/workspace-header";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

import { makeWorkspace } from "./fixtures";

const mockSetOptions = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: mockSetOptions }),
}));

describe("WorkspaceHeader", () => {
  beforeEach(() => jest.clearAllMocks());

  it("wires both native header controls and explains a blocked add", async () => {
    const onAddPane = jest.fn();
    const onActions = jest.fn();
    await render(
      <WorkspaceHeader
        canAddPane={false}
        onActions={onActions}
        onAddPane={onAddPane}
        workspace={makeWorkspace()}
      />,
      { wrapper: ThemeProvider },
    );

    const options = mockSetOptions.mock.calls.at(-1)?.[0] as
      | { title: string; headerRight: () => ReactElement }
      | undefined;
    expect(options?.title).toBe("spawn mobile");
    const controls = await render(options?.headerRight() as ReactElement, {
      wrapper: ThemeProvider,
    });
    const add = controls.getByLabelText("Add terminal or files");
    expect(add.props["accessibilityHint"]).toBe(
      "This tab is full. A tab can contain up to 16 panes.",
    );
    expect(add).toHaveStyle({
      height: sizing.control.iconButton.default,
      width: sizing.control.iconButton.default,
    });

    await fireEvent.press(add);
    await fireEvent.press(controls.getByLabelText("Workspace actions"));
    expect(onAddPane).toHaveBeenCalledTimes(1);
    expect(onActions).toHaveBeenCalledTimes(1);
  });
});
