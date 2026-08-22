import Svg, { Path } from "react-native-svg";

import { pressroomColors, spacing } from "@/theme";

import { BRAND_MARK_PATH, WORDMARK_PATHS } from "./brand-paths";

const BRAND_MARK_VIEWBOX = "0 0 538 538";
const WORDMARK_VIEWBOX = "0 0 1753 370";
const WORDMARK_ASPECT_RATIO = 1753 / 370;

export interface BrandMarkProps {
  accessibilityLabel?: string;
  color?: string;
  size?: number;
  testID?: string;
}

/** The canonical wet-ink trident. Its default ink is fixed across themes. */
export function BrandMark({
  accessibilityLabel = "spawnd mark",
  color = pressroomColors.hellfire,
  size = spacing[6.5],
  testID,
}: BrandMarkProps): React.JSX.Element {
  return (
    <Svg
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      height={size}
      viewBox={BRAND_MARK_VIEWBOX}
      width={size}
      {...(testID ? { testID } : {})}
    >
      <Path d={BRAND_MARK_PATH} fill={color} {...(testID ? { testID: `${testID}-path` } : {})} />
    </Svg>
  );
}

export interface WordmarkProps {
  accessibilityLabel?: string;
  color?: string;
  height?: number;
  testID?: string;
}

/** The canonical drawn lowercase wordmark; this is artwork, not typeset copy. */
export function Wordmark({
  accessibilityLabel = "spawnd",
  color = pressroomColors.hellfire,
  height = spacing[5],
  testID,
}: WordmarkProps): React.JSX.Element {
  return (
    <Svg
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      height={height}
      viewBox={WORDMARK_VIEWBOX}
      width={height * WORDMARK_ASPECT_RATIO}
      {...(testID ? { testID } : {})}
    >
      {WORDMARK_PATHS.map((path, index) => (
        <Path
          d={path}
          fill={color}
          key={path}
          {...(testID ? { testID: `${testID}-path-${index}` } : {})}
        />
      ))}
    </Svg>
  );
}
