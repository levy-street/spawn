import { fireEvent, render, waitFor } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";

import { AboutScreen } from "@/components/longtail/about-screen";
import { installCommandsForBaseUrl } from "@/components/longtail/public-content";
import { ThemeProvider } from "@/theme";

const mockToastError = jest.fn();

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: mockToastError }),
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

describe("about and public content", () => {
  beforeEach(() => jest.clearAllMocks());

  test("builds deployment-specific normal and prebuilt-only commands", () => {
    expect(installCommandsForBaseUrl("https://spawn.example/api")).toEqual({
      standard: "curl -fsSL https://spawn.example/install.sh | sh",
      windows: 'wsl -- bash -c "curl -fsSL https://spawn.example/install.sh | sh"',
      prebuiltOnly: "curl -fsSL https://spawn.example/install.sh | sh -s -- --prebuilt-only",
    });
  });

  test("shows version, legal, security, and copies the install command", async () => {
    const screen = await render(
      <ThemeProvider>
        <AboutScreen baseUrl="https://spawn.example" version="2.4.0" />
      </ThemeProvider>,
    );

    expect(screen.getByText("Version 2.4.0")).toBeOnTheScreen();
    // The product's own mark beside its name, not a stand-in glyph.
    expect(screen.getByTestId("about-brand-mark")).toBeOnTheScreen();
    expect(screen.getByText("MIT / Apache-2.0")).toBeOnTheScreen();
    expect(screen.getByText("We introduce. We never listen.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Copy install command" }));
    await waitFor(() =>
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
        "curl -fsSL https://spawn.example/install.sh | sh",
      ),
    );
  });
});
