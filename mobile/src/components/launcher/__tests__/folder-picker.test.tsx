import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { FolderPicker } from "@/components/launcher/folder-picker";
import type { HostTransport } from "@/terminal/transport/types";
import { ThemeProvider } from "@/theme";

describe("FolderPicker Windows paths", () => {
  test("round-trips canonical native paths through folder navigation and selection", async () => {
    const request = jest.fn(async (operation: string, payload?: unknown) => {
      if (operation === "fs.home") return { home_dir: "C:\\Users\\Ada" };
      if (operation === "fs.list") {
        const path = (payload as { path: string }).path;
        return {
          path,
          home_dir: "C:\\Users\\Ada",
          entries:
            path === "C:\\Users\\Ada"
              ? [
                  {
                    name: "Work",
                    path: "C:\\Users\\Ada\\Work",
                    kind: "directory",
                    is_dir: true,
                  },
                ]
              : [],
          next_cursor: null,
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const transport: HostTransport = {
      hostId: "host-windows",
      state: "ready",
      open: jest.fn(async () => undefined),
      close: jest.fn(),
      request: request as HostTransport["request"],
      cancel: jest.fn(),
      on: jest.fn(() => () => undefined) as HostTransport["on"],
    };
    const onSelect = jest.fn();
    const view = await render(
      <ThemeProvider>
        <FolderPicker
          onSelect={onSelect}
          pathFlavor="windows"
          recentDirectories={[]}
          transport={transport}
          transportState="ready"
        />
      </ThemeProvider>,
    );

    expect(await screen.findByDisplayValue("C:\\Users\\Ada")).toBeOnTheScreen();
    expect(screen.getByPlaceholderText("C:\\path\\to\\folder")).toBeOnTheScreen();
    expect(await screen.findByText("Work")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Open folder Work" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("fs.list", {
        path: "C:\\Users\\Ada\\Work",
        cursor: 0,
      }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Choose “Work”" }));
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Ada\\Work");
    await view.unmount();
  });
});
