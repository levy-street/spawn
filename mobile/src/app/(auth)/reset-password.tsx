import { useLocalSearchParams } from "expo-router";
import { ResetPasswordScreen } from "@/components/auth/reset-password-form";
import { singleRouteParam } from "@/components/auth/route-param";

export default function ResetPasswordRoute() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = singleRouteParam(params.token);
  return <ResetPasswordScreen {...(token === undefined ? {} : { token })} />;
}
