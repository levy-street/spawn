import { render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { hostAgent, skill } from "@/components/hosts/__tests__/fixtures";
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

  test("keeps availability visible without server-authorized execution controls", async () => {
    await render(
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <HostAgentRow agent={{ ...hostAgent, auto_update: true }} />
        </SafeAreaProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText("Codex")).toBeOnTheScreen();
    expect(screen.getByText("update 1.3.0")).toBeOnTheScreen();
    expect(screen.getByText("/usr/local/bin/codex")).toBeOnTheScreen();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Auto update Codex" })).toBeNull();
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
