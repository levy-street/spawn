import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import copy from "@/components/settings/support-log-copy.json";
import { confirm } from "@/components/ui/confirm";
import { putSupportLog, readSupportLog, supportLogRefusal } from "@/data/api/endpoints/support-log";
import { qk } from "@/data/queryKeys";
import { supportLogDevice } from "@/data/trust/support-log-device";

export function useSupportLog(accountId: string) {
  const client = useQueryClient();
  const key = [...qk.supportLog(), accountId];
  const { data: state, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => readSupportLog(signal).catch(() => null),
    retry: false,
    gcTime: 0,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [approved, setApproved] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const available = !!state;
  const panel = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    panel.current = controller;
    const { signal } = controller;
    void supportLogDevice(client, accountId, signal, false)
      .then((signer) => {
        if (!signal.aborted) setApproved(signer !== null);
      })
      .catch(() => {
        if (!signal.aborted) setApproved(false);
      });
    return () => {
      controller.abort();
      panel.current = null;
    };
  }, [client, accountId, available]);

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
        const sign = await supportLogDevice(client, accountId, signal, true).catch(() => null);
        if (signal.aborted) return;
        if (!sign) {
          setMessage("");
          setApproved(false);
          return;
        }
        const fresh = await readSupportLog(signal);
        if (signal.aborted) return;
        const statement = await sign(enabled, fresh);
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
      approved !== true ||
      client.isMutating({ mutationKey }) ||
      enabled === (state.sharing === "on")
    )
      return;
    mutation.mutate(enabled);
  }
  return {
    state,
    approved,
    change,
    busy,
    message,
  };
}
