import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { NameDialog } from "@/components/files/name-dialog";
import { ThemeProvider } from "@/theme";

describe("NameDialog path flavor", () => {
  test("applies Windows leaf-name rules before sending a name", async () => {
    const onConfirm = jest.fn();
    const view = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, right: 0, bottom: 34, left: 0 },
        }}
      >
        <ThemeProvider>
          <NameDialog
            confirmLabel="Create folder"
            onConfirm={onConfirm}
            onDismiss={jest.fn()}
            pathFlavor="windows"
            title="New folder"
            visible
          />
        </ThemeProvider>
      </SafeAreaProvider>,
    );

    await fireEvent.changeText(screen.getByLabelText("Name"), "CON.txt");
    expect(screen.getByText("Choose a different name.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Create folder" }));
    expect(onConfirm).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText("Name"), "project");
    await fireEvent.press(screen.getByRole("button", { name: "Create folder" }));
    expect(onConfirm).toHaveBeenCalledWith("project");
    await view.unmount();
  });
});
