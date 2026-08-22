import { useLocalSearchParams } from "expo-router";
import { singleRouteParam } from "@/components/auth/route-param";
import { SignupScreen } from "@/components/auth/signup-form";

export default function SignupRoute() {
  const params = useLocalSearchParams<{ invite?: string | string[] }>();
  const invite = singleRouteParam(params.invite);
  return <SignupScreen {...(invite === undefined ? {} : { invite })} />;
}
