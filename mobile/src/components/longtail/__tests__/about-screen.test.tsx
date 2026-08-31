import { fireEvent, render, waitFor } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { AboutScreen } from "@/components/longtail/about-screen";
import * as publicContent from "@/components/longtail/public-content";
import {
  installCommandsForBaseUrl,
  installTargetsForBaseUrl,
  nativeWindowsAvailableFromRelease,
  WINDOWS_PLATFORM_ID,
} from "@/components/longtail/public-content";
import { presentShareSheet } from "@/lib/share";
import { ThemeProvider } from "@/theme";

const mockToastError = jest.fn();

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: mockToastError }),
}));

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock("@/data/queries/release", () => ({
  useRelease: () => ({ data: undefined }),
}));

jest.mock("@/lib/share", () => ({
  presentShareSheet: jest.fn(async () => ({ action: "sharedAction" })),
}));

describe("about and public content", () => {
  beforeEach(() => jest.clearAllMocks());

  test("builds every deployment-specific command from one origin", () => {
    expect(installCommandsForBaseUrl("https://spawn.example/api")).toEqual({
      standard: "curl -fsSL https://spawn.example/install.sh | sh",
      windows: "irm https://spawn.example/install.ps1 | iex",
      windowsWsl: 'wsl -- bash -c "curl -fsSL https://spawn.example/install.sh | sh"',
      prebuiltOnly: "curl -fsSL https://spawn.example/install.sh | sh -s -- --prebuilt-only",
      windowsWslPrebuiltOnly:
        'wsl -- bash -c "curl -fsSL https://spawn.example/install.sh | sh -s -- --prebuilt-only"',
    });
  });

  test("stages native Windows from the published daemon target", () => {
    expect(WINDOWS_PLATFORM_ID).toBe("windows-x86_64");
    expect(nativeWindowsAvailableFromRelease(undefined)).toBe(false);
    expect(
      nativeWindowsAvailableFromRelease({
        daemon: { targets: { [WINDOWS_PLATFORM_ID]: {} } },
      }),
    ).toBe(true);
    expect(
      installTargetsForBaseUrl("https://spawn.example/api", false).map((target) => target.label),
    ).toEqual(["macOS / Linux", "Windows (WSL)"]);
    expect(
      installTargetsForBaseUrl("https://spawn.example/api", true).map((target) => [
        target.id,
        target.label,
        target.prompt,
      ]),
    ).toEqual([
      ["unix", "macOS / Linux", "$"],
      ["windows", "Windows", "PS>"],
    ]);
  });

  test("shows native targets and shares all install routes", async () => {
    const screen = await render(
      <ThemeProvider>
        <AboutScreen baseUrl="https://spawn.example" nativeWindowsAvailable version="2.4.0" />
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
    await fireEvent.press(screen.getByRole("button", { name: "Copy Windows install command" }));
    await waitFor(() =>
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
        "irm https://spawn.example/install.ps1 | iex",
      ),
    );
    // WSL is the fallback, so a machine with a native Windows build is not
    // also offered the route through a Linux environment inside it.
    expect(screen.queryByRole("button", { name: "Copy Windows WSL install command" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy Windows WSL prebuilt-only command" }),
    ).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Share" }));
    expect(presentShareSheet).toHaveBeenCalledWith({
      message: [
        "Install spawnd on a machine you control.",
        "",
        "macOS / Linux:",
        "curl -fsSL https://spawn.example/install.sh | sh",
        "",
        "Windows:",
        "irm https://spawn.example/install.ps1 | iex",
        "",
        "After installation, run spawnd possess on that machine.",
      ].join("\n"),
    });
    await screen.unmount();
  });

  // spawnd.dev sells subscriptions now, and its own chrome reaches pricing from
  // every page. An in-app tappable link into it is the shape App Store
  // guideline 3.1.1 calls steering, so the download row is gone — everything it
  // led to is on this screen already. docs/BILLING.md §6.1.
  test("offers the install commands here rather than a link to the download page", async () => {
    const screen = await render(
      <ThemeProvider>
        <AboutScreen baseUrl="https://spawn.example" nativeWindowsAvailable version="2.4.0" />
      </ThemeProvider>,
    );

    expect(screen.queryByText("Download & install")).toBeNull();
    expect(screen.getByText("curl -fsSL https://spawn.example/install.sh | sh")).toBeOnTheScreen();
    expect(screen.getByText("Open source")).toBeOnTheScreen();
    await screen.unmount();
  });

  // Apple 5.1.1(i) requires the privacy policy to be reachable from inside the
  // app, not only from the store listing. Without this the app is not
  // submittable to either store — which was true before billing and is simply
  // overdue. docs/BILLING.md §5.2.
  test("links the privacy policy and terms from inside the app", async () => {
    const screen = await render(
      <ThemeProvider>
        <AboutScreen baseUrl="https://spawn.example" nativeWindowsAvailable version="2.4.0" />
      </ThemeProvider>,
    );

    expect(screen.getByText("Privacy policy")).toBeOnTheScreen();
    expect(screen.getByText("Terms of service")).toBeOnTheScreen();
    await screen.unmount();
  });

  // The rule is about a link's destination, never about the site it lands on:
  // legal pages are required, and a page that prices something is refused.
  test("no link in About leads to a page that sells or prices anything", () => {
    const urls = Object.entries(publicContent)
      .filter(([, value]) => typeof value === "string" && value.startsWith("http"))
      .map(([, value]) => value as string);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/\/pricing|checkout|\/upgrade|\/subscribe|\/billing/i);
    }
  });

  test("keeps the WSL-only About state truthful before native availability", async () => {
    const screen = await render(
      <ThemeProvider>
        <AboutScreen
          baseUrl="https://spawn.example"
          nativeWindowsAvailable={false}
          version="2.4.0"
        />
      </ThemeProvider>,
    );

    expect(
      screen.getByText(
        "Install spawnd on a Mac or Linux machine you control, or on Windows through WSL.",
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText("Windows (via WSL)")).toBeOnTheScreen();
    expect(screen.queryByText("irm https://spawn.example/install.ps1 | iex")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Share" }));
    expect(presentShareSheet).toHaveBeenCalledWith({
      message: [
        "Install spawnd on a machine you control.",
        "",
        "macOS / Linux:",
        "curl -fsSL https://spawn.example/install.sh | sh",
        "",
        "Windows (WSL):",
        'wsl -- bash -c "curl -fsSL https://spawn.example/install.sh | sh"',
        "",
        "After installation, run spawnd possess on that machine.",
      ].join("\n"),
    });
    await screen.unmount();
  });
});
