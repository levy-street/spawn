import { render, screen } from "@testing-library/react-native";
import { View } from "react-native";

import { AuthShell } from "@/components/auth/auth-shell";
import { BrandMark, Wordmark } from "@/components/brand/brand-mark";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { AgentIdentity, AgentLogoKey } from "@/data/types/domain";
import { lightColors, pressroomColors, ThemeProvider } from "@/theme";

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

describe("auth Pressroom surface", () => {
  test("uses fixed Pressroom inks and canonical artwork instead of theme surfaces", async () => {
    await render(
      <ThemeProvider>
        <AuthShell description="Continue to your machines." title="Welcome back">
          <View />
        </AuthShell>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("auth-pressroom")).toHaveStyle({
      backgroundColor: pressroomColors.void,
    });
    expect(screen.getByTestId("auth-pressroom")).not.toHaveStyle({
      backgroundColor: lightColors.background,
    });
    expect(screen.getByTestId("auth-plate")).toHaveStyle({
      backgroundColor: pressroomColors.char,
      borderColor: pressroomColors.lineG,
    });
    expect(screen.getByTestId("auth-brand-mark-path")).toHaveProp(
      "fill",
      svgBrush(pressroomColors.hellfire),
    );
    expect(screen.getByTestId("auth-wordmark-path-0")).toHaveProp(
      "fill",
      svgBrush(pressroomColors.hellfire),
    );
    expect(screen.getByTestId("auth-altar", { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByText("SPAWN")).not.toBeOnTheScreen();
  });
});
