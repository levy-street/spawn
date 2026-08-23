import { fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { hostAgent, onlineHost, skill } from "@/components/hosts/__tests__/fixtures";
import { HostAgentRow } from "@/components/hosts/host-agent-row";
import { HostSkillsList } from "@/components/hosts/host-skills-list";
import { ThemeProvider } from "@/theme";

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

describe("host agent availability and skills", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  test("shows installed version, available update, policy, and install confirmation wiring", async () => {
    const onInstall = jest.fn();
    const onPolicyChange = jest.fn();
    await render(
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <HostAgentRow
            agent={hostAgent}
            hostName={onlineHost.name}
            installing={false}
            onInstall={onInstall}
            onPolicyChange={onPolicyChange}
            policySaving={false}
            result={null}
          />
        </SafeAreaProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText("Codex")).toBeOnTheScreen();
    expect(screen.getByText("update 1.3.0")).toBeOnTheScreen();
    expect(screen.getByText("/usr/local/bin/codex")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("switch", { name: "Auto update Codex" }));
    expect(onPolicyChange).toHaveBeenCalledWith(true);

    await fireEvent.press(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByText("Update Codex?")).toBeOnTheScreen();
    expect(screen.getByText("Runs the install command on office-mac.")).toBeOnTheScreen();
    const updateButtons = screen.getAllByRole("button", { name: "Update" });
    const confirmButton = updateButtons.at(-1);
    if (!confirmButton) throw new Error("Update confirmation button was not rendered");
    await fireEvent.press(confirmButton);
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  test("disables install and auto update when the definition has no install command", async () => {
    await render(
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <HostAgentRow
            agent={{ ...hostAgent, install: null, installed: false }}
            hostName={onlineHost.name}
            installing={false}
            onInstall={jest.fn()}
            onPolicyChange={jest.fn()}
            policySaving={false}
            result={null}
          />
        </SafeAreaProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText("No install command is available.")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Auto update Codex" })).toBeDisabled();
  });

  test("renders account skills and default grant state", async () => {
    await render(
      <ThemeProvider>
        <View>
          <HostSkillsList skills={[skill]} />
        </View>
      </ThemeProvider>,
    );
    expect(screen.getByText("review")).toBeOnTheScreen();
    expect(screen.getByText("Review changed code before shipping.")).toBeOnTheScreen();
    expect(screen.getByText("default")).toBeOnTheScreen();
  });
});
