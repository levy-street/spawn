import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { runInShell, type ShellCommandSink } from "@/components/launcher/shell-handoff";
import { confirm } from "@/components/ui/confirm";
import { getSession } from "@/data/api/endpoints/sessions";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { qk } from "@/data/queryKeys";
import { haptics } from "@/lib/haptics";

export function useShellHandoff() {
  const queryClient = useQueryClient();
  return useCallback(
    async ({
      session,
      terminal,
      command,
      purpose,
    }: {
      session: SessionOut;
      terminal: ShellCommandSink | null;
      command: string;
      purpose: string;
    }) => {
      const result = await runInShell({
        session,
        terminal,
        command,
        purpose,
        confirmStop: ({ title, description, confirmLabel }) =>
          confirm({ title, description, confirmLabel, destructive: true }),
        getSession,
        onSession: (latest) => {
          queryClient.setQueryData(qk.session(latest.id), latest);
        },
      });
      if (result === "sent") haptics.success();
      if (result === "busy") haptics.error();
      return result;
    },
    [queryClient],
  );
}
