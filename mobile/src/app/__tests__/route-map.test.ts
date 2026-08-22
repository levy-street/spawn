import { APP_ROUTE_MAP, FULL_SCREEN_BACK_OPTIONS } from "@/app/(drawer)/_layout";
import { resolveIncomingLink } from "@/lib/linking";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const DOCUMENTED_URLS = [
  "/workspaces",
  "/workspaces/archived",
  "/workspace/[id]",
  "/hosts",
  "/host/[id]",
  "/host/[id]/agents",
  "/host/[id]/files",
  "/legion",
  "/settings",
  "/settings/account",
  "/settings/appearance",
  "/settings/notifications",
  "/settings/hosts",
  "/settings/agents",
  "/settings/skills",
  "/settings/templates",
  "/settings/devices",
  "/settings/trust",
  "/settings/profile",
  "/settings/server",
  "/settings/about",
  "/admin",
  "/admin/invites",
  "/admin/users",
  "/admin/emails",
] as const;

describe("native stack route map", () => {
  it.each(DOCUMENTED_URLS)("keeps %s addressable", (url) => {
    expect(APP_ROUTE_MAP[url]).toBeDefined();
  });

  it("contains no drawer navigator routes", () => {
    expect(Object.values(APP_ROUTE_MAP)).not.toContain("drawer");
    expect(Object.values(APP_ROUTE_MAP).some((route) => route.includes("drawer"))).toBe(false);
  });

  it.each([
    ["/legion", "/legion"],
    ["/admin", "/admin"],
    [`/hosts/${HOST_ID}`, `/host/${HOST_ID}`],
    [`/w/${WORKSPACE_ID}`, `/workspace/${WORKSPACE_ID}`],
  ])("keeps incoming %s links on the stack URL %s", (incoming, href) => {
    expect(resolveIncomingLink(incoming)?.href).toBe(href);
  });

  it("enables the full-screen horizontal back gesture on pushed cards", () => {
    expect(FULL_SCREEN_BACK_OPTIONS).toEqual({
      presentation: "card",
      gestureEnabled: true,
      gestureDirection: "horizontal",
      fullScreenGestureEnabled: true,
    });
  });
});
