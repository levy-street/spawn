import { useLocalSearchParams } from "expo-router";
import { singleRouteParam } from "@/components/auth/route-param";
import { VerifyEmailScreen } from "@/components/auth/verify-email-content";

export default function VerifyEmailRoute() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = singleRouteParam(params.token);
  return <VerifyEmailScreen {...(token === undefined ? {} : { token })} />;
}
