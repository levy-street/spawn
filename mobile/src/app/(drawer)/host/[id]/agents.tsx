import { Redirect, useLocalSearchParams } from "expo-router";

/**
 * A host's agents used to have a screen of their own. Their availability is on
 * the host's Overview now, and the account's skills stay in Settings → Skills,
 * as in the browser; this stub keeps installs that have not applied the OTA,
 * restored navigation state and old links landing on the host. Delete it one
 * OTA cycle after the cockpit ships.
 */
export default function RetiredHostAgentsRoute(): React.JSX.Element {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? (params.id[0] ?? "") : (params.id ?? "");
  return <Redirect href={{ pathname: "/host/[id]", params: { id, tab: "overview" } }} />;
}
