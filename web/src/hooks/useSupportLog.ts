import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { confirm } from "@/components/ui/confirm";
import {
  type BrowserDeviceRegistrationState,
  browserDeviceRegistrationQueryKey,
} from "@/lib/browser-device-registration";
import { putSupportLog, readSupportLog, supportLogRefusal } from "@/lib/support-log";
import copy from "@/lib/support-log-copy.json";
import { supportLogDevice } from "@/lib/support-log-device";

export function useSupportLog(accountId: string) {
  const client = useQueryClient();
  const key = ["support-log", accountId];
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
    () =>
      client.getQueryData<BrowserDeviceRegistrationState>(
        browserDeviceRegistrationQueryKey(accountId),
      ),
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
    const focus = () => {
      if (!document.hidden) void refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
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
          body: copy.description,
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
