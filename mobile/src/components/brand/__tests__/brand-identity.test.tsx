import { render, screen } from "@testing-library/react-native";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthShell } from "@/components/auth/auth-shell";
import { BrandMark, Wordmark } from "@/components/brand/brand-mark";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { AgentIdentity, AgentLogoKey } from "@/data/types/domain";
import { darkColors, FixedThemeProvider, lightColors, ThemeProvider } from "@/theme";

const IDENTITIES: readonly AgentIdentity[] = [
  {
    kind: "claude-code",
    displayName: "Claude Code",
    logoKey: "claude-code",
    monogramSeed: "Claude Code",
  },
  { kind: "codex", displayName: "Codex", logoKey: "codex", monogramSeed: "Codex" },
  {
    kind: "opencode",
    displayName: "OpenCode",
    logoKey: "opencode",
    monogramSeed: "OpenCode",
  },
  { kind: "aider", displayName: "Aider Sonnet", logoKey: "aider", monogramSeed: "Aider" },
  { kind: "shell", displayName: "Shell", logoKey: "shell", monogramSeed: "Shell" },
];

const PLATES: Record<AgentLogoKey, { backgroundColor: string; borderColor: string }> = {
  "claude-code": { backgroundColor: "#D97757", borderColor: "rgba(255,255,255,0.10)" },
  codex: { backgroundColor: "#FFFFFF", borderColor: "rgba(0,0,0,0.10)" },
  opencode: { backgroundColor: "#000000", borderColor: "rgba(255,255,255,0.20)" },
  aider: { backgroundColor: "#10231B", borderColor: "rgba(255,255,255,0.10)" },
  shell: { backgroundColor: "#1C2128", borderColor: "rgba(255,255,255,0.10)" },
};

function svgBrush(hex: string): { payload: number; type: 0 } {
  return { payload: Number.parseInt(`FF${hex.slice(1)}`, 16), type: 0 };
}

function nativeGradientColor(hex: string): number {
  return Number.parseInt(`FF${hex.slice(1)}`, 16) | 0;
}

describe("spawnd brand artwork", () => {
  test("renders the canonical mark and wordmark at requested sizes and colors", async () => {
    await render(
      <View>
        <BrandMark color="#123456" size={42} testID="brand-mark" />
        <Wordmark color="#654321" height={18} testID="wordmark" />
      </View>,
    );

    expect(screen.getByTestId("brand-mark")).toHaveProp("height", 42);
    expect(screen.getByTestId("brand-mark")).toHaveProp("width", 42);
    expect(screen.getByTestId("brand-mark-path")).toHaveProp("fill", svgBrush("#123456"));
    expect(screen.getByTestId("wordmark")).toHaveProp("height", 18);
    expect(screen.getByTestId("wordmark")).toHaveProp("width", 18 * (1753 / 370));
    expect(screen.getAllByTestId(/^wordmark-path-/)).toHaveLength(6);
    for (const path of screen.getAllByTestId(/^wordmark-path-/)) {
      expect(path).toHaveProp("fill", svgBrush("#654321"));
    }
  });
});

describe("agent brand plates", () => {
  test("renders distinct fixed artwork for all five known identities", async () => {
    await render(
      <ThemeProvider>
        <View>
          {IDENTITIES.map((identity) => (
            <AgentIcon identity={identity} key={identity.kind} size={32} />
          ))}
        </View>
      </ThemeProvider>,
    );

    for (const identity of IDENTITIES) {
      const logoKey = identity.logoKey as AgentLogoKey;
      expect(screen.getByTestId(`agent-icon-${logoKey}`)).toHaveStyle(PLATES[logoKey]);
      expect(screen.getByTestId(`agent-mark-${logoKey}`)).toBeOnTheScreen();
    }
  });

  test("preserves the Codex user-space gradient and exact fixed stops", async () => {
    const codex = IDENTITIES.find((identity) => identity.logoKey === "codex");
    if (!codex) throw new Error("Codex fixture missing");
    const view = await render(
      <ThemeProvider>
        <AgentIcon identity={codex} />
      </ThemeProvider>,
    );

    const gradient = view.container.queryAll((node) => node.type === "RNSVGLinearGradient")[0];
    if (!gradient) throw new Error("Codex gradient missing");
    expect(gradient).toHaveProp("gradientUnits", 1);
    expect(gradient).toHaveProp("gradient", [
      0,
      nativeGradientColor("#B1A7FF"),
      0.5,
      nativeGradientColor("#7A9DFF"),
      1,
      nativeGradientColor("#3941FF"),
    ]);
    expect(screen.getByTestId("codex-plate")).toHaveProp("fill", svgBrush("#FFFFFF"));
  });

  test("falls back to a neutral monogram for an unknown identity", async () => {
    await render(
      <ThemeProvider>
        <AgentIcon
          identity={{
            kind: "custom",
            displayName: "Nebula",
            logoKey: null,
            monogramSeed: "Nebula",
          }}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("agent-icon-monogram")).toHaveStyle({
      backgroundColor: lightColors.muted,
      borderColor: lightColors.border,
      borderRadius: 8,
    });
    expect(screen.getByText("N")).toBeOnTheScreen();
  });
});

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

describe("auth surface", () => {
  function renderSheet(mode: "light" | "dark") {
    return render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <FixedThemeProvider mode={mode}>
          <AuthShell brand description="Continue to your machines." title="Welcome back">
            <View />
          </AuthShell>
        </FixedThemeProvider>
      </SafeAreaProvider>,
    );
  }

  test("prints on the sheet itself rather than a plate laid on it", async () => {
    const view = await renderSheet("dark");

    // The account surface is the sheet. Nothing may reintroduce a card between
    // the ground and the form printed on it.
    expect(view.queryByTestId("auth-plate")).toBeNull();
    expect(view.getByTestId("auth-brand-mark-path")).toHaveProp(
      "fill",
      svgBrush(darkColors.brandAccent),
    );
    expect(view.getByTestId("auth-wordmark-path-0")).toHaveProp(
      "fill",
      svgBrush(darkColors.brandAccent),
    );
    expect(view.queryByText("SPAWN")).not.toBeOnTheScreen();
    // The press bed's corner crosses are gone; nothing decorative frames the sheet.
    expect(view.queryAllByText("+")).toHaveLength(0);
  });

  test("follows the appearance setting instead of pinning itself dark", async () => {
    const dark = await renderSheet("dark");

    expect(dark.getByTestId("auth-sheet")).toHaveStyle({
      backgroundColor: darkColors.background,
    });
    expect(dark.getByTestId("auth-altar", { includeHiddenElements: true })).toBeOnTheScreen();
    dark.unmount();

    const light = await renderSheet("light");

    expect(light.getByTestId("auth-sheet")).toHaveStyle({
      backgroundColor: lightColors.background,
    });
    expect(light.getByTestId("auth-brand-mark-path")).toHaveProp(
      "fill",
      svgBrush(lightColors.brandAccent),
    );
    // Ink on paper is a grey smudge: the plate stays off a light sheet.
    expect(light.queryByTestId("auth-altar", { includeHiddenElements: true })).toBeNull();
  });
});
