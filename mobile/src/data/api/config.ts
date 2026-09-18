import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

const API_URL_STORAGE_KEY = "spawn.api.base-url.v1";
const API_URL_EXTRA_KEY = "apiUrl";
const DEV_API_PORT = "3000";
const FALLBACK_API_URL = `http://localhost:${DEV_API_PORT}`;

/**
 * In Expo Go the JS runs on the phone, so "localhost" is the phone — not the
 * machine running spawn. Expo hands us the Metro host it connected to, which
 * is that machine's LAN address, so derive the dev default from it rather than
 * hard-coding an IP that changes with the network. `scripts/dev.sh` serves the
 * API on 8010 (SPAWN_DEV_API_PORT) and must be started with
 * SPAWN_DEV_API_HOST=0.0.0.0 for the phone to reach it.
 */
export function deriveDevApiUrl(hostUri: string | undefined | null): string | null {
  if (!hostUri) return null;
  const host = hostUri
    .trim()
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
    .split("/")[0];
  const hostname = host?.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host?.split(":")[0];
  if (!hostname || hostname.length === 0) return null;
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;
  return `http://${hostname}:${DEV_API_PORT}`;
}

const DEFAULT_API_URL = deriveDevApiUrl(Constants.expoConfig?.hostUri) ?? FALLBACK_API_URL;

export type BaseUrlSource = "runtime override" | "expo.extra" | "compiled default";

export interface BaseUrlResolution {
  url: string;
  source: BaseUrlSource;
}

export interface BaseUrlCandidates {
  runtimeOverride: string | null;
  expoExtra: unknown;
  compiledDefault?: string;
}

let runtimeOverride: string | null | undefined;
let loadingOverride: Promise<string | null> | null = null;
let persistingOverride: Promise<void> = Promise.resolve();

function normalizeAbsoluteBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new Error("Enter a SPAWN D server URL");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid SPAWN D server URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SPAWN D server URL must use http or https");
  }
  if (url.hostname.length === 0) {
    throw new Error("SPAWN D server URL must include a host");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SPAWN D server URL cannot include credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Enter a SPAWN D server URL");
  }
  if (/^https?:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Enter a valid SPAWN D server URL");
  }

  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const candidate = explicitScheme
    ? trimmed
    : trimmed.startsWith("//")
      ? `https:${trimmed}`
      : `https://${trimmed}`;
  return normalizeAbsoluteBaseUrl(candidate);
}

export function resolveBaseUrl({
  runtimeOverride: override,
  expoExtra,
  compiledDefault = DEFAULT_API_URL,
}: BaseUrlCandidates): BaseUrlResolution {
  if (override !== null) {
    return { url: normalizeAbsoluteBaseUrl(override), source: "runtime override" };
  }
  if (typeof expoExtra === "string" && expoExtra.trim().length > 0) {
    return { url: normalizeAbsoluteBaseUrl(expoExtra), source: "expo.extra" };
  }
  return {
    url: normalizeAbsoluteBaseUrl(compiledDefault),
    source: "compiled default",
  };
}

async function loadOverride(): Promise<string | null> {
  if (runtimeOverride !== undefined) return runtimeOverride;
  loadingOverride ??= AsyncStorage.getItem(API_URL_STORAGE_KEY).then((stored) => {
    // A cold read cannot undo a server selected while native storage was busy.
    if (runtimeOverride !== undefined) return runtimeOverride;
    runtimeOverride = stored === null ? null : normalizeAbsoluteBaseUrl(stored);
    return runtimeOverride;
  });
  return loadingOverride;
}

export async function getBaseUrlResolution(): Promise<BaseUrlResolution> {
  return resolveBaseUrl({
    runtimeOverride: await loadOverride(),
    expoExtra: Constants.expoConfig?.extra?.[API_URL_EXTRA_KEY],
  });
}

export async function getBaseUrl(): Promise<string> {
  return (await getBaseUrlResolution()).url;
}

export async function setBaseUrl(value: string | null): Promise<void> {
  const normalized = value === null ? null : normalizeAbsoluteBaseUrl(value);
  runtimeOverride = normalized;
  loadingOverride = Promise.resolve(normalized);
  const write = persistingOverride
    .catch(() => undefined)
    .then(async () => {
      if (normalized === null) await AsyncStorage.removeItem(API_URL_STORAGE_KEY);
      else await AsyncStorage.setItem(API_URL_STORAGE_KEY, normalized);
    });
  persistingOverride = write;
  await write;
}

export const apiConfig = {
  defaultBaseUrl: DEFAULT_API_URL,
  storageKey: API_URL_STORAGE_KEY,
} as const;
