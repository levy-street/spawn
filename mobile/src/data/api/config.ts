import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

const API_URL_STORAGE_KEY = "spawn.api.base-url.v1";
const API_URL_EXTRA_KEY = "apiUrl";
const DEFAULT_API_URL = "http://localhost:8000";

let runtimeOverride: string | null | undefined;
let loadingOverride: Promise<string | null> | null = null;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Spawn API URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Spawn API URL cannot include credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function configuredBaseUrl(): string {
  const configured = Constants.expoConfig?.extra?.[API_URL_EXTRA_KEY];
  return typeof configured === "string" ? normalizeBaseUrl(configured) : DEFAULT_API_URL;
}

async function loadOverride(): Promise<string | null> {
  if (runtimeOverride !== undefined) return runtimeOverride;
  loadingOverride ??= AsyncStorage.getItem(API_URL_STORAGE_KEY).then((stored) => {
    runtimeOverride = stored === null ? null : normalizeBaseUrl(stored);
    return runtimeOverride;
  });
  return loadingOverride;
}

export async function getBaseUrl(): Promise<string> {
  return (await loadOverride()) ?? configuredBaseUrl();
}

export async function setBaseUrl(value: string | null): Promise<void> {
  const normalized = value === null ? null : normalizeBaseUrl(value);
  runtimeOverride = normalized;
  loadingOverride = Promise.resolve(normalized);
  if (normalized === null) {
    await AsyncStorage.removeItem(API_URL_STORAGE_KEY);
  } else {
    await AsyncStorage.setItem(API_URL_STORAGE_KEY, normalized);
  }
}

export const apiConfig = {
  defaultBaseUrl: DEFAULT_API_URL,
  storageKey: API_URL_STORAGE_KEY,
} as const;
