import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import copy from "@/components/settings/support-log-copy.json";
import { confirm } from "@/components/ui/confirm";
import { putSupportLog, readSupportLog, supportLogRefusal } from "@/data/api/endpoints/support-log";
import { qk } from "@/data/queryKeys";
import type { RegisteredPhone } from "@/data/trust/registration";
import { supportLogDevice } from "@/data/trust/support-log-device";

export function useSupportLog(accountId: string) {
  const client = useQueryClient();
  const key = [...qk.supportLog(), accountId];
  const { data: state, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readSupportLog(accountId, signal),
    retry: false,
    gcTime: 0,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const registration = useSyncExternalStore(
    client.getQueryCache().subscribe,
    () => client.getQueryData<RegisteredPhone>(qk.browserDeviceRegistration(accountId)),
    () => undefined,
  );
  const [hasIdentity, setHasIdentity] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const available = !!state;
  const panel = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    panel.current = controller;
    const { signal } = controller;
    setHasIdentity(null);
    void supportLogDevice(accountId, registration)
      .then((signer) => {
        if (!signal.aborted) setHasIdentity(signer !== null);
      })
      .catch(() => {
        if (!signal.aborted) setMessage(copy.failure);
      });
    return () => {
      controller.abort();
      panel.current = null;
    };
  }, [registration, accountId, available]);

  const mutationKey = ["support-log-consent", accountId];
  const busy = useIsMutating({ mutationKey }) > 0;
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const focus = AppState.addEventListener("focus", () => void refetch({ cancelRefetch: false }));
    return () => focus.remove();
  }, [refetch]);
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    mutationFn: async (enabled: boolean) => {
      const signal = panel.current?.signal;
      if (!signal || signal.aborted) return;
      if (
        enabled &&
        !(await confirm({
          title: copy.confirmTitle,
          description: copy.description,
          confirmLabel: copy.turnOn,
          cancelLabel: copy.cancel,
        }))
      )
        return;
      if (signal.aborted) return;
      try {
        const sign = await supportLogDevice(accountId, registration);
        if (signal.aborted) return;
        if (!sign) {
          setMessage("");
          setHasIdentity(false);
          return;
        }
        const statement = await sign(client, enabled, signal);
        if (signal.aborted) return;
        try {
          await putSupportLog(statement, signal);
          if (!signal.aborted) setMessage(copy.sent);
        } catch (error) {
          if (!signal.aborted) setMessage(supportLogRefusal(error));
        }
        if (!signal.aborted) await refetch();
      } catch {
        if (!signal.aborted) setMessage(copy.failure);
      }
    },
  });
  function change(enabled: boolean) {
    // Check synchronously too: two presses can arrive before React paints the
    // disabled switch. The account-scoped mutation survives a panel remount.
    if (
      !state ||
      hasIdentity !== true ||
      client.isMutating({ mutationKey }) ||
      enabled === (state.sharing === "on")
    )
      return;
    mutation.mutate(enabled);
  }
  return {
    state,
    hasIdentity,
    change,
    busy,
    message,
  };
}
