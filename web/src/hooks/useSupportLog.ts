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
      client.getQueryState<BrowserDeviceRegistrationState>(
        browserDeviceRegistrationQueryKey(accountId),
      ),
    () => undefined,
  );
  const record = registration?.data;
  const local = record?.status === "ready" ? record.device : undefined;
  const removed = !!record && (record.status !== "ready" || !!local?.revoked_at);
  const deviceId = local?.id;
  const publicKey = local?.public_key;
  const [matchingKey, setMatchingKey] = useState<boolean | null>(null);
  const hasIdentity = registration?.status === "success" ? !removed && matchingKey : null;
  const [message, setMessage] = useState("");
  const available = !!state;
  const panel = useRef<AbortController | null>(null);
  const retryLookup = useRef<(() => void) | null>(null);
  useEffect(() => {
    setMatchingKey(null);
    if (!available || !deviceId || !publicKey || removed) return;
    const controller = new AbortController();
    panel.current = controller;
    const { signal } = controller;
    const lookup = () => {
      retryLookup.current = null;
      void supportLogDevice(accountId, deviceId, publicKey)
        .then((signer) => {
          if (signal.aborted) return;
          setMatchingKey(signer !== null);
          if (!signer) retryLookup.current = lookup;
        })
        .catch(() => {
          if (signal.aborted) return;
          retryLookup.current = lookup;
          setMessage(copy.failure);
        });
    };
    lookup();
    return () => {
      controller.abort();
      panel.current = null;
      retryLookup.current = null;
    };
  }, [accountId, available, deviceId, publicKey, removed]);

  const registrationReads = registration?.dataUpdateCount;
  useEffect(() => {
    if (registrationReads && retryLookup.current) {
      setMessage("");
      retryLookup.current();
    }
  }, [registrationReads]);

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
      if (!signal || signal.aborted || !deviceId || !publicKey) return;
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
        const sign = await supportLogDevice(accountId, deviceId, publicKey);
        if (signal.aborted) return;
        if (!sign) {
          setMessage("");
          setMatchingKey(false);
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
