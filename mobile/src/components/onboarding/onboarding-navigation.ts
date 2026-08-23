import type { Router } from "expo-router";

type OnboardingBackRouter = Pick<Router, "back" | "canGoBack" | "replace">;

/** Leave a pushed pairing scene without stranding a directly opened route. */
export function leaveOnboarding(router: OnboardingBackRouter): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace("/hosts");
}
