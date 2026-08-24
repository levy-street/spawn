import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * app.json holds everything static; this layer adds what only the build knows.
 *
 * The API host is the important one. `src/data/api/config.ts` prefers
 * `extra.apiUrl` over its derived dev default, so leaving it unset is what
 * keeps `expo start` pointed at the LAN machine running the server. Release
 * builds set EXPO_PUBLIC_API_URL (see eas.json environments) and it becomes
 * the compiled default — https://spawnd.dev for production.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  return {
    ...config,
    name: config.name ?? "spawn",
    slug: config.slug ?? "spawn",
    // The org shows as "levy-street" in the Expo dashboard, which is its display
    // name; `owner` takes the account slug, and that is `trevcavill`. Changing
    // this to the name on screen is a build failure, not a tidy-up.
    owner: "trevcavill",
    ios: {
      ...config.ios,
      // Sign in with Apple is a native button on iOS, so the build needs the
      // entitlement; the web flow reaches Apple through the redirect instead.
      usesAppleSignIn: true,
    },
    extra: {
      ...config.extra,
      ...(apiUrl ? { apiUrl } : {}),
    },
  };
};
