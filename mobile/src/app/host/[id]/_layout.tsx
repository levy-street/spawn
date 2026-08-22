import { Stack } from "expo-router";

// Gives the root navigator's `host/[id]` screen a real child group; otherwise
// index/agents/files flatten into siblings and the screen name does not exist.
export default function HostDetailLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false }} />;
}
