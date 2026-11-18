import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { confirm } from "@/components/ui/confirm";
import { ApiError } from "@/lib/api";
import {
  putSupportLog,
  readSupportLog,
  type SupportLogState,
  supportLogRefusal,
} from "@/lib/support-log";
import { checkedConsentTime } from "@/lib/support-log-consent";
import copy from "@/lib/support-log-copy.json";
import { supportLogDevice } from "@/lib/support-log-device";

export function useSupportLog(accountId: string) {
  const client = useQueryClient();
  const key = ["support-log", accountId];
  const {
    data: state,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: key,
    queryFn: () => readSupportLog().catch(() => null),
    retry: false,
    gcTime: 0,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [approved, setApproved] = useState<boolean | "unavailable" | null>(null);
  useEffect(() => {
    let current = true;
    setApproved(null);
    if (state && dataUpdatedAt) {
      void supportLogDevice(
        client,
        accountId,
        state.hosts.map((host) => host.id),
      )
        .then((signer) => {
          if (current) setApproved(!!signer);
        })
        .catch(() => {
          if (current) setApproved("unavailable");
        });
    }
    return () => {
      current = false;
    };
  }, [client, accountId, state, dataUpdatedAt]);

  const mutationKey = ["support-log-consent", accountId];
  const busy = useIsMutating({ mutationKey }) > 0;
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
      if (!state) return;
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
      if (!mounted.current || !client.getQueryData(key)) return;
      const stamp = checkedConsentTime(state.next_issued_at_ms);
      const sign = await supportLogDevice(
        client,
        accountId,
        state.hosts.map((host) => host.id),
      );
      if (!mounted.current) return;
      if (!sign) {
        setMessage("");
        setApproved(false);
        return;
      }
      const statement = await sign(enabled, stamp);
      if (!mounted.current) return;
      let updated: SupportLogState | null;
      try {
        updated = await putSupportLog(statement);
        if (mounted.current) setMessage(copy.sent);
      } catch (error) {
        if (!mounted.current) return;
        setMessage(supportLogRefusal(error));
        if (!(error instanceof ApiError && error.status === 409)) return;
        // Keep the displayed choice and the stale message if the one reread fails.
        updated = await readSupportLog().catch(() => null);
      }
      if (updated && client.getQueryState(key)) {
        await client.cancelQueries({ queryKey: key, exact: true });
        client.setQueryData(key, updated);
      }
    },
    onError: () => {
      if (mounted.current) setMessage(copy.failure);
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
    message: message || (approved === "unavailable" ? copy.failure : ""),
  };
}
