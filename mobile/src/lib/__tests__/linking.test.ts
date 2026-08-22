import {
  clearPendingAuthenticatedLink,
  rememberPendingAuthenticatedLink,
  resolveIncomingLink,
  subscribeToIncomingUrls,
  takePendingAuthenticatedLink,
  UNIVERSAL_LINK_HOST,
} from "@/lib/linking";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const TAB_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const INVITE_TOKEN = "a".repeat(32);
const ACCOUNT_TOKEN = "b".repeat(43);

describe("incoming spawn links", () => {
  test.each([
    {
      input: `/signup?invite=${INVITE_TOKEN}`,
      route: "/(auth)/signup",
      params: { invite: INVITE_TOKEN },
    },
    {
      input: `/verify-email?token=${ACCOUNT_TOKEN}`,
      route: "/(auth)/verify-email",
      params: { token: ACCOUNT_TOKEN },
    },
    {
      input: `/reset-password?token=${ACCOUNT_TOKEN}`,
      route: "/(auth)/reset-password",
      params: { token: ACCOUNT_TOKEN },
    },
    { input: "/device", route: "/(onboarding)/device", params: {} },
    {
      input: "/onboarding?step=host",
      route: "/(onboarding)",
      params: { step: "host" },
    },
    { input: "/login", route: "/(auth)/login", params: {} },
    { input: "/forgot-password", route: "/(auth)/forgot-password", params: {} },
    { input: "/app", route: "/", params: {} },
    { input: `/hosts/${HOST_ID}`, route: "/host/[id]", params: { id: HOST_ID } },
    {
      input: `/hosts/${HOST_ID}/files?path=%2FUsers%2Fspawn%20project`,
      route: "/host/[id]/files",
      params: { id: HOST_ID, path: "/Users/spawn project" },
    },
    { input: "/legion", route: "/(tabs)/hosts/legion", params: {} },
    { input: "/admin", route: "/admin", params: {} },
    {
      input: `/w/${WORKSPACE_ID}?tab=${TAB_ID}&focus=${SESSION_ID}`,
      route: "/workspace/[id]",
      params: { id: WORKSPACE_ID, tab: TAB_ID, focus: SESSION_ID },
    },
    {
      input: `/sessions/${SESSION_ID}`,
      route: "/terminal/[sessionId]",
      params: { sessionId: SESSION_ID },
    },
    {
      input: "/download",
      route: "/(tabs)/settings",
      params: { section: "download" },
    },
    {
      input: "/security",
      route: "/(tabs)/settings",
      params: { section: "security" },
    },
  ])("maps $input to $route", ({ input, route, params }) => {
    expect(resolveIncomingLink(input)).toMatchObject({ route, params });
  });

  it("resolves custom-scheme, universal, and Expo Go cold-start URLs", () => {
    expect(resolveIncomingLink(`spawn://sessions/${SESSION_ID}`)?.href).toBe(
      `/terminal/${SESSION_ID}`,
    );
    expect(resolveIncomingLink(`https://${UNIVERSAL_LINK_HOST}/hosts/${HOST_ID}`)?.route).toBe(
      "/host/[id]",
    );
    expect(resolveIncomingLink(`exp://192.0.2.1:8081/--/sessions/${SESSION_ID}`)?.route).toBe(
      "/terminal/[sessionId]",
    );
  });

  it("rejects malformed credentials, identifiers, steps, paths, and foreign origins", () => {
    expect(resolveIncomingLink("/signup?invite=short")).toBeNull();
    expect(resolveIncomingLink("/verify-email?token=short")).toBeNull();
    expect(resolveIncomingLink("/onboarding?step=unknown")).toBeNull();
    expect(resolveIncomingLink("/hosts/not-a-uuid")).toBeNull();
    expect(resolveIncomingLink(`/hosts/${HOST_ID}/files?path=`)).toBeNull();
    expect(resolveIncomingLink("https://example.net/login")).toBeNull();
  });

  it("retains one auth-gated intent in memory and consumes it once", () => {
    clearPendingAuthenticatedLink();
    const link = resolveIncomingLink(`/sessions/${SESSION_ID}`);
    expect(link).not.toBeNull();
    if (link) rememberPendingAuthenticatedLink(link);

    expect(takePendingAuthenticatedLink()).toMatchObject({ route: "/terminal/[sessionId]" });
    expect(takePendingAuthenticatedLink()).toBeNull();
  });

  it("delivers a cold-start URL and foreground links through one subscription", async () => {
    let listener: (event: { url: string }) => void = () => undefined;
    const remove = jest.fn();
    const received: string[] = [];
    const dispose = subscribeToIncomingUrls(
      {
        getInitialURL: async () => `spawn://sessions/${SESSION_ID}`,
        addEventListener: (_type, nextListener) => {
          listener = nextListener;
          return { remove };
        },
      },
      (url) => received.push(url),
    );

    await Promise.resolve();
    listener({ url: `spawn://hosts/${HOST_ID}` });
    expect(received).toEqual([`spawn://sessions/${SESSION_ID}`, `spawn://hosts/${HOST_ID}`]);

    dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
