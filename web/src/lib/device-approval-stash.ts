export const DEVICE_APPROVAL_STASH_KEY = "spawn:device-approval";
export const DEVICE_APPROVAL_STASH_MAX_AGE_MS = 30 * 60 * 1_000;

export interface DeviceApprovalStash {
  ref?: string;
  code?: string;
  k?: string;
  at: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function approvalParts(url: URL): Omit<DeviceApprovalStash, "at"> | null {
  const ref = url.searchParams.get("ref")?.trim();
  const code = url.searchParams.get("code")?.trim();
  if (!(ref || code)) return null;
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const k = hash.get("k");
  return {
    ...(ref ? { ref } : { code: code as string }),
    ...(k !== null ? { k } : {}),
  };
}

/** Save the out-of-band fragment before AuthGate leaves `/device`. */
export function stashDeviceApproval(
  storage: StorageLike,
  href: string,
  now = Date.now(),
): DeviceApprovalStash | null {
  const url = new URL(href, "https://spawnd.dev");
  if (url.pathname !== "/device") return null;
  const parts = approvalParts(url);
  if (!parts) return null;
  const value = { ...parts, at: now };
  storage.setItem(DEVICE_APPROVAL_STASH_KEY, JSON.stringify(value));
  return value;
}

function readStash(storage: StorageLike, now: number): DeviceApprovalStash | null {
  const raw = storage.getItem(DEVICE_APPROVAL_STASH_KEY);
  if (!raw) return null;
  storage.removeItem(DEVICE_APPROVAL_STASH_KEY);
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceApprovalStash>;
    const hasIdentifier =
      (typeof parsed.ref === "string" && parsed.ref.length > 0) ||
      (typeof parsed.code === "string" && parsed.code.length > 0);
    if (
      !hasIdentifier ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at) ||
      parsed.at > now ||
      now - parsed.at > DEVICE_APPROVAL_STASH_MAX_AGE_MS ||
      (parsed.k !== undefined && typeof parsed.k !== "string")
    ) {
      return null;
    }
    return parsed as DeviceApprovalStash;
  } catch {
    return null;
  }
}

/**
 * Restore a fragment lost to the server redirect. The stash is consumed once.
 * A fragment is only joined to the same identifier (or to a URL with none),
 * so a stale ceremony can never lend its key to a different approval ref.
 */
export function restoreDeviceApproval(
  storage: StorageLike,
  href: string,
  now = Date.now(),
  /**
   * Pages allowed to consume a stash. `/device` is the approval page itself;
   * `/onboarding` claims it too, so someone who just created an account
   * finishes the approval inside the onboarding flow instead of being sent
   * through the app chrome and back out again.
   */
  allowedPaths: readonly string[] = ["/device"],
): string | null {
  const stash = readStash(storage, now);
  if (!stash) return null;
  const url = new URL(href, "https://spawnd.dev");
  if (!allowedPaths.includes(url.pathname)) return null;

  const currentRef = url.searchParams.get("ref");
  const currentCode = url.searchParams.get("code");
  const currentIdentifier = currentRef
    ? `ref:${currentRef}`
    : currentCode
      ? `code:${currentCode}`
      : null;
  const stashIdentifier = stash.ref ? `ref:${stash.ref}` : `code:${stash.code}`;
  if (currentIdentifier !== null && currentIdentifier !== stashIdentifier) return null;

  if (!currentIdentifier) {
    if (stash.ref) url.searchParams.set("ref", stash.ref);
    else if (stash.code) url.searchParams.set("code", stash.code);
  }
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!hash.has("k") && stash.k !== undefined) hash.set("k", stash.k);
  url.hash = hash.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}
