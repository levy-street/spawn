import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { FileBreadcrumbs } from "@/components/files/breadcrumbs";
import { ThemeProvider } from "@/theme";

describe("FileBreadcrumbs", () => {
  test("is a strip under the header, not a pane that grows into the listing", async () => {
    const onNavigate = jest.fn();
    await render(
      <ThemeProvider>
        <FileBreadcrumbs
          homeDir="/Users/charlie"
          onNavigate={onNavigate}
          path="/Users/charlie/dev"
        />
      </ThemeProvider>,
    );

    // A scroll view grows by default; this one must leave the room to the files.
    const style = StyleSheet.flatten(screen.getByTestId("file-breadcrumbs").props["style"]);
    expect(style).toMatchObject({ flexGrow: 0, flexShrink: 0 });

    // It is also the way up: every folder on the path is a stop.
    expect(screen.getByText("dev")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Open Home" }));
    expect(onNavigate).toHaveBeenCalledWith("/Users/charlie");
  });
});
