import Svg, { Path } from "react-native-svg";

import type { ProviderId } from "@/data/api/schemas/auth";
import { useTheme } from "@/theme";

/**
 * The provider's own mark, beside its name on the sign-in button.
 *
 * Not decoration. Apple's Human Interface Guidelines require its mark to
 * accompany "Sign in with Apple", and Google's branding rules say the same for
 * the G — a wordmark alone is the version that gets flagged in review. Each is
 * drawn at the brand's own colours except Apple's, which is monochrome by rule
 * and therefore takes the button's ink so it survives both themes.
 */
export function ProviderMark({ provider, size = 18 }: { provider: ProviderId; size?: number }) {
  const theme = useTheme();

  if (provider === "apple") {
    return (
      <Svg height={size} viewBox="0 0 24 24" width={size}>
        <Path
          d="M17.05 12.53c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.18-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.21 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.67-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.33-3.54zM14.86 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.7-.92 2.7.97.08 1.97-.49 2.58-1.23z"
          fill={theme.colors.foreground}
        />
      </Svg>
    );
  }

  if (provider === "google") {
    return (
      <Svg height={size} viewBox="0 0 24 24" width={size}>
        <Path
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          fill="#4285F4"
        />
        <Path
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"
          fill="#34A853"
        />
        <Path
          d="M5.84 14.11a6.6 6.6 0 010-4.22V7.05H2.18a11 11 0 000 9.9l3.66-2.84z"
          fill="#FBBC05"
        />
        <Path
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 00-9.82 6.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51z"
          fill="#EA4335"
        />
      </Svg>
    );
  }

  if (provider === "github") {
    return (
      <Svg height={size} viewBox="0 0 24 24" width={size}>
        <Path
          d="M12 .5C5.73.5.7 5.57.7 11.86c0 5.03 3.22 9.29 7.69 10.79.56.11.77-.24.77-.54 0-.27-.01-1.16-.02-2.1-3.13.69-3.79-1.34-3.79-1.34-.51-1.31-1.25-1.66-1.25-1.66-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.17 1.72 1.17 1 1.73 2.63 1.23 3.27.94.1-.73.39-1.23.71-1.51-2.5-.29-5.13-1.26-5.13-5.6 0-1.24.44-2.25 1.16-3.04-.12-.29-.5-1.44.11-3 0 0 .95-.31 3.1 1.16a10.6 10.6 0 015.65 0c2.15-1.47 3.09-1.16 3.09-1.16.62 1.56.23 2.71.11 3 .73.79 1.16 1.8 1.16 3.04 0 4.35-2.63 5.31-5.14 5.59.4.35.76 1.04.76 2.1 0 1.52-.01 2.75-.01 3.12 0 .3.2.66.78.54 4.46-1.5 7.68-5.76 7.68-10.79C23.3 5.57 18.27.5 12 .5z"
          fill={theme.colors.foreground}
        />
      </Svg>
    );
  }

  // Microsoft's four squares, which are the mark — there is no glyph version.
  return (
    <Svg height={size} viewBox="0 0 24 24" width={size}>
      <Path d="M2 2h9.5v9.5H2z" fill="#F25022" />
      <Path d="M12.5 2H22v9.5h-9.5z" fill="#7FBA00" />
      <Path d="M2 12.5h9.5V22H2z" fill="#00A4EF" />
      <Path d="M12.5 12.5H22V22h-9.5z" fill="#FFB900" />
    </Svg>
  );
}
