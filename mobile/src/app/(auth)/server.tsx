import { ServerPanel } from "@/components/settings/server-panel";

/**
 * Reachable while signed out: the server URL has to be settable *before* login,
 * or a wrong URL is a deadlock — you cannot sign in to fix the address you need
 * in order to sign in.
 */
export default function SignedOutServerRoute(): React.JSX.Element {
  return <ServerPanel />;
}
