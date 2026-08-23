import * as SecureStore from "expo-secure-store";

import { authToken } from "@/data/api/auth-token";
import { setBaseUrl } from "@/data/api/config";
import {
  rememberPendingAuthenticatedLink,
  resolveIncomingLink,
  takePendingAuthenticatedLink,
} from "@/lib/linking";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
let originSequence = 0;

function jwtWithExpiry(exp: number): string {
  const payload = globalThis
    .btoa(JSON.stringify({ sub: "user:test", kind: "access", exp }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.signature`;
}

beforeEach(async () => {
  originSequence += 1;
  await setBaseUrl(`https://g07-${originSequence}.spawn.test`);
  await authToken.clear();
  jest.clearAllMocks();
});

describe("production lifecycle wiring", () => {
  it("clears an abandoned authenticated link when credentials are cleared", async () => {
    await authToken.set(jwtWithExpiry(Math.floor(Date.now() / 1000) + 3_600));
    const link = resolveIncomingLink(`/sessions/${SESSION_ID}`);
    expect(link).not.toBeNull();
    if (link) rememberPendingAuthenticatedLink(link);

    await authToken.clear();

    expect(takePendingAuthenticatedLink()).toBeNull();
  });

  it("notifies token subscribers exactly once when get observes expiry", async () => {
    await authToken.set(jwtWithExpiry(Math.floor(Date.now() / 1000) - 1));
    const subscriber = jest.fn();
    const unsubscribe = authToken.subscribe(subscriber);

    await expect(authToken.get()).resolves.toBeNull();
    await expect(authToken.get()).resolves.toBeNull();

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
