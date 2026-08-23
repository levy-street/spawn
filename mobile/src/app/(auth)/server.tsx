import { SignedOutServerScreen } from "@/components/auth/server-form";

/**
 * Reachable while signed out: the server URL has to be settable *before* login,
 * or a wrong URL is a deadlock — you cannot sign in to fix the address you need
 * in order to sign in. It is printed on the account sheet rather than the app's
 * settings chrome, because signed out there is no app around it yet.
 */
export default function SignedOutServerRoute(): React.JSX.Element {
  return <SignedOutServerScreen />;
}
