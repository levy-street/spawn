import { Stack, useLocalSearchParams } from "expo-router";
import { renderRouter, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";

import RetiredHostAgentsRoute from "@/app/(drawer)/host/[id]/agents";
import { cockpitTab } from "@/components/hosts/cockpit/cockpit-model";

const HOST_ID = "11111111-1111-4111-8111-111111111111";

/** The host's page with its body stubbed: only which tab it opens on is under test. */
function CockpitStub(): React.JSX.Element {
  const params = useLocalSearchParams<{ id?: string; tab?: string }>();
  return <Text testID="cockpit">{`${params.id}:${cockpitTab(params.tab)}`}</Text>;
}

const ROUTES = {
  _layout: () => <Stack screenOptions={{ headerShown: false }} />,
  "host/[id]/index": CockpitStub,
  "host/[id]/agents": RetiredHostAgentsRoute,
};

describe("host page routes", () => {
  it.each([
    [`/host/${HOST_ID}`, "overview"],
    [`/host/${HOST_ID}?tab=sessions`, "sessions"],
    [`/host/${HOST_ID}?tab=access`, "access"],
    [`/host/${HOST_ID}?tab=files`, "files"],
    // A tab this build does not know opens the page, on Overview.
    [`/host/${HOST_ID}?tab=desktop`, "overview"],
  ])("%s opens the host's page on %s", async (url, tab) => {
    const view = await renderRouter(ROUTES, { initialUrl: url });
    expect(await view.findByTestId("cockpit")).toHaveTextContent(`${HOST_ID}:${tab}`);
  });

  // Kept for one OTA cycle: the host's agents moved into its Overview.
  it("redirects the retired agents screen to the host's Overview", async () => {
    const rendered = renderRouter(ROUTES, { initialUrl: `/host/${HOST_ID}/agents` });
    const view = await rendered;
    await waitFor(() => expect(rendered.getPathname()).toBe(`/host/${HOST_ID}`));
    expect(rendered.getSearchParams()).toMatchObject({ tab: "overview" });
    expect(await view.findByTestId("cockpit")).toHaveTextContent(`${HOST_ID}:overview`);
  });
});
