import { Redirect } from "expo-router";

/**
 * The fleet used to live at /legion. It is the Hosts tab now; this stub keeps
 * installs that have not applied the OTA, restored navigation state and old
 * spawn://legion links landing there. Delete it one OTA cycle after the
 * rename ships (lib/linking.ts keeps resolving the old address on its own).
 */
export default function RetiredFleetRoute(): React.JSX.Element {
  return <Redirect href="/hosts" />;
}
