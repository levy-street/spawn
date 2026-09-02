import { execSync } from "node:child_process";
import type { ConfigContext, ExpoConfig } from "expo/config";

function mobileTree(): string | undefined {
  const stamped = process.env["EXPO_PUBLIC_SPAWN_MOBILE_TREE"]?.trim();
  if (stamped) return stamped;

  try {
    const tree = execSync("git rev-parse HEAD:mobile", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return tree || undefined;
  } catch {
    return undefined;
  }
}

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
  const apiUrl = process.env["EXPO_PUBLIC_API_URL"]?.trim();
  const tree = mobileTree();

  return {
    ...config,
    name: config.name ?? "SPAWN D",
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
      infoPlist: {
        ...config.ios?.infoPlist,
        /**
         * Export compliance, answered once here so no build has to ask again.
         *
         * `false` claims the Category 5 Part 2 exemption for cryptography
         * limited to authentication and digital signature. What the app
         * actually does, as of this writing:
         *
         *   - ed25519 sign/verify only (`lib/crypto/ed25519.ts`) — device
         *     pairing and endorsement. Signature, not confidentiality.
         *   - SHA digests, getRandomValues, randomUUID via expo-crypto.
         *     Hashing and entropy are not encryption.
         *   - HTTPS and WebRTC's DTLS-SRTP, both provided by iOS.
         *   - Keychain via expo-secure-store, also provided by iOS.
         *
         * There is no symmetric cipher in the app at all — no AES, no ChaCha,
         * no encrypt/decrypt call anywhere in `src/`. The sealed trust bundle
         * is the one piece of real confidentiality encryption in the product,
         * and this app cannot open it: it fetches the ciphertext as opaque
         * bytes and `passkeyPrfCapability.available` is hard `false`, because
         * unsealing needs a WebAuthn PRF secret only the web client obtains.
         *
         * Revisit this the day the app decrypts that bundle itself, or gains
         * any cipher used for confidentiality rather than authentication.
         */
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    extra: {
      ...config.extra,
      ...(apiUrl ? { apiUrl } : {}),
      ...(tree ? { mobileTree: tree } : {}),
    },
  };
};
