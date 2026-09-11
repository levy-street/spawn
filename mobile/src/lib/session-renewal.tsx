import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { authToken, sessionTokenNeedsRenewal } from "@/data/api/auth-token";
import { ApiError } from "@/data/api/client";
import { renewSession } from "@/data/api/endpoints/auth";

export interface SessionRenewalDependencies {
  getToken(): Promise<string | null>;
  renew(): Promise<{ access_token: string }>;
  storeToken(token: string): Promise<void>;
  nowSeconds(): number;
}

const defaultDependencies: SessionRenewalDependencies = {
  getToken: authToken.get,
  renew: renewSession,
  storeToken: authToken.set,
  nowSeconds: () => Date.now() / 1_000,
};

/** Performs one foreground check. A 404 is the documented old-server fallback. */
export async function renewSessionIfNeeded(
  dependencies: SessionRenewalDependencies = defaultDependencies,
): Promise<"renewed" | "not-needed" | "unsupported"> {
  if (dependencies === defaultDependencies) {
    const credentials = await authToken.snapshot();
    return renewSessionIfNeeded({
      ...defaultDependencies,
      getToken: async () => credentials.token,
      storeToken: async (jwt) => {
        await authToken.setIfCurrent(jwt, credentials, "identity");
      },
    });
  }
  const token = await dependencies.getToken();
  if (token === null || !sessionTokenNeedsRenewal(token, dependencies.nowSeconds())) {
    return "not-needed";
  }
  try {
    const response = await dependencies.renew();
    await dependencies.storeToken(response.access_token);
    return "renewed";
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return "unsupported";
    throw error;
  }
}

/** App-load plus foreground belt-and-braces renewal for the stored mobile bearer. */
export function SessionRenewal(): null {
  const checking = useRef(false);
  const check = useCallback(() => {
    if (checking.current) return;
    checking.current = true;
    void renewSessionIfNeeded()
      .catch(() => undefined)
      .finally(() => {
        checking.current = false;
      });
  }, []);

  useEffect(() => {
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => subscription.remove();
  }, [check]);

  return null;
}
