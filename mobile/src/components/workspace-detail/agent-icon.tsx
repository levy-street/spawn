import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

import { Monogram } from "@/components/ui/monogram";
import type { AgentIdentity } from "@/data/types/domain";
import { borderWidth, useTheme } from "@/theme";

const GLYPH_SCALE = 0.58;

export interface AgentIconProps {
  identity: AgentIdentity;
  size?: number;
}

export function AgentIcon({ identity, size }: AgentIconProps) {
  const theme = useTheme();
  const resolvedSize = size ?? theme.space(8);
  const glyphSize = Math.round(resolvedSize * GLYPH_SCALE);

  if (identity.logoKey === null) {
    return (
      <Monogram
        accessibilityLabel={identity.displayName}
        seed={identity.monogramSeed}
        size={resolvedSize}
        testID="agent-icon-monogram"
      />
    );
  }

  const plate = (() => {
    switch (identity.logoKey) {
      case "claude-code":
        return { background: theme.colors.warning, foreground: theme.colors.primaryForeground };
      case "codex":
        return { background: theme.colors.card, foreground: theme.colors.info };
      case "opencode":
        return { background: theme.colors.foreground, foreground: theme.colors.background };
      case "aider":
        return { background: theme.colors.shell, foreground: theme.colors.success };
      case "shell":
        return { background: theme.colors.shell, foreground: theme.colors.success };
    }
  })();

  return (
    <View
      accessibilityLabel={identity.displayName}
      accessibilityRole="image"
      style={[
        styles.plate,
        {
          backgroundColor: plate.background,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          borderWidth: borderWidth.hairline,
          height: resolvedSize,
          width: resolvedSize,
        },
      ]}
      testID={`agent-icon-${identity.logoKey}`}
    >
      {identity.logoKey === "codex" ? (
        <CodexMark size={resolvedSize} />
      ) : identity.logoKey === "claude-code" ? (
        <ClaudeCodeMark color={plate.foreground} size={glyphSize} />
      ) : identity.logoKey === "opencode" ? (
        <OpenCodeMark color={plate.foreground} size={glyphSize} />
      ) : identity.logoKey === "aider" ? (
        <AiderMark color={plate.foreground} size={glyphSize} />
      ) : (
        <ShellMark color={plate.foreground} size={glyphSize} />
      )}
    </View>
  );
}

interface MarkProps {
  color: string;
  size: number;
}

function ClaudeCodeMark({ color, size }: MarkProps) {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
        fill={color}
        fillRule="evenodd"
      />
    </Svg>
  );
}

function CodexMark({ size }: { size: number }) {
  const theme = useTheme();
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Defs>
        <LinearGradient id="codex-gradient" x1="4.33" x2="19.5" y1="18.25" y2="5">
          <Stop stopColor={theme.colors.warning} />
          <Stop offset="0.5" stopColor={theme.colors.info} />
          <Stop offset="1" stopColor={theme.colors.brandAccent} />
        </LinearGradient>
      </Defs>
      <Path
        d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
        fill={theme.colors.card}
      />
      <Path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275a.09.09 0 00.08.021 4.55 4.55 0 013.046.275l.163.079a4.581 4.581 0 012.188 2.399 4.24 4.24 0 01.181 2.818.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854a4.548 4.548 0 01-2.337 1.554.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-2.024-1.952 4.582 4.582 0 01-.384-3.259.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.4-.266.816-.453 1.247-.557a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill="url(#codex-gradient)"
      />
    </Svg>
  );
}

function OpenCodeMark({ color, size }: MarkProps) {
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" fill={color} />
    </Svg>
  );
}

function AiderMark({ color, size }: MarkProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d="M5 19 12 5l7 14M8.3 14.4h7.4"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </Svg>
  );
}

function ShellMark({ color, size }: MarkProps) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d="M4.5 6 10 12l-5.5 6M13 19h6.5"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  plate: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
